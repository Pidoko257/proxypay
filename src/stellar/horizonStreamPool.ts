import * as StellarSdk from "stellar-sdk";
import { getStellarServer } from "../config/stellar";
import { redisClient } from "../config/redis";
import EventEmitter from "events";

/**
 * Configuration for the stream reconnection backoff.
 * Initial delay 1s, max 30s, exponential factor 2, jitter enabled.
 */
const BACKOFF_CONFIG = {
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  factor: 2,
  jitter: true,
};

/**
 * HorizonStreamPool streams payment operations for a set of Stellar accounts.
 * It persists the latest paging cursor in Redis so that a restart resumes
 * from the last processed operation. It also handles automatic reconnection
 * with exponential backoff when the SSE connection drops.
 */
export class HorizonStreamPool extends EventEmitter {
  /** Redis key prefix for storing cursors per account */
  private static readonly REDIS_KEY_PREFIX = "horizon:cursor";

  private readonly accounts: string[];
  private readonly server: StellarSdk.Horizon.Server;
  private readonly streams: Map<string, any> = new Map(); // Holds EventSource objects

  constructor(accounts: string[]) {
    super();
    if (!accounts || accounts.length === 0) {
      throw new Error("HorizonStreamPool requires at least one account to monitor");
    }
    this.accounts = accounts;
    this.server = getStellarServer();
  }

  /** Start streaming for all configured accounts */
  public async start(): Promise<void> {
    for (const account of this.accounts) {
      // fire-and-forget – each stream runs independently
      this.startStreamForAccount(account).catch((err) => {
        console.error(`HorizonStreamPool: failed to start stream for ${account}`, err);
      });
    }
  }

  /** Stop all active streams */
  public async stop(): Promise<void> {
    for (const [account, source] of this.streams.entries()) {
      if (source && typeof source.close === "function") {
        try {
          source.close();
        } catch (e) {
          console.warn(`HorizonStreamPool: error closing stream for ${account}`, e);
        }
      }
    }
    this.streams.clear();
  }

  /** Internal: start (or restart) the SSE stream for a single account */
  private async startStreamForAccount(account: string, attempt = 0): Promise<void> {
    const redisKey = `${HorizonStreamPool.REDIS_KEY_PREFIX}:${account}`;
    let cursor: string | undefined;
    try {
      cursor = await redisClient.get(redisKey);
    } catch (e) {
      console.warn(`HorizonStreamPool: unable to read cursor for ${account}`, e);
    }

    const stream = this.server
      .payments()
      .forAccount(account)
      .cursor(cursor ?? "now")
      .stream({
        // The Stellar SDK invokes onmessage for each payment operation
        onmessage: async (msg: StellarSdk.Horizon.ServerApi.PaymentOperationRecord) => {
          try {
            // Persist the paging token for the next reconnect
            if (msg.paging_token) {
              await redisClient.set(redisKey, msg.paging_token);
            }
            // Emit a generic event that consumers can listen to
            this.emit("payment", msg);
          } catch (err) {
            console.error(`HorizonStreamPool: error handling payment for ${account}`, err);
          }
        },
        onerror: async (error: any) => {
          console.warn(`HorizonStreamPool: stream error for ${account}`, error);
          // Close the broken stream if possible
          if (stream && typeof stream.close === "function") {
            try {
              stream.close();
            } catch (_) {}
          }
          this.streams.delete(account);
          // Schedule reconnection with backoff
          const delay = this.calculateBackoff(attempt);
          console.log(`HorizonStreamPool: reconnecting ${account} in ${delay} ms`);
          await new Promise((res) => setTimeout(res, delay));
          // Retry with incremented attempt counter
          this.startStreamForAccount(account, attempt + 1).catch((e) => {
            console.error(`HorizonStreamPool: reconnection failed for ${account}`, e);
          });
        },
      });

    // Store active stream reference for clean shutdowns
    this.streams.set(account, stream);
  }

  /** Calculate backoff delay based on attempt number */
  private calculateBackoff(attempt: number): number {
    const { initialDelayMs, maxDelayMs, factor, jitter } = BACKOFF_CONFIG;
    const expDelay = Math.min(initialDelayMs * Math.pow(factor, attempt), maxDelayMs);
    if (jitter) {
      // Apply full jitter: random value between 0 and expDelay
      return Math.floor(Math.random() * expDelay);
    }
    return expDelay;
  }
}
