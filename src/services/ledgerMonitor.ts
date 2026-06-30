import axios from "axios";
import { getHorizonUrls } from "../config/stellar";
import {
  stellarLedgerCloseTimeSeconds,
  stellarLedgerSequence,
} from "../utils/metrics";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ROLLING_WINDOW = 10; // number of ledgers to average over
const ALERT_THRESHOLD_SECONDS = parseFloat(
  process.env.LEDGER_CLOSE_TIME_ALERT_THRESHOLD_S || "10",
);
// Minimum gap (ms) between repeated alerts for the same breach episode
const ALERT_COOLDOWN_MS = parseInt(
  process.env.LEDGER_ALERT_COOLDOWN_MS || "300000", // 5 minutes
  10,
);
// SSE reconnect delay on stream error (ms)
const RECONNECT_DELAY_MS = parseInt(
  process.env.LEDGER_MONITOR_RECONNECT_DELAY_MS || "5000",
  10,
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HorizonLedgerRecord {
  sequence: number;
  closed_at: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Ring buffer of the last ROLLING_WINDOW close-time deltas (seconds). */
const closeTimes: number[] = [];

let prevClosedAt: Date | null = null;
let lastAlertAt: number | null = null;
let activeStreamClose: (() => void) | null = null;
let isRunning = false;

// ---------------------------------------------------------------------------
// Alert helpers
// ---------------------------------------------------------------------------

async function sendSlackAlert(avgSeconds: number): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  const message = {
    text: `⚠️ *Stellar Ledger Close Time Alert*\nRolling average close time is *${avgSeconds.toFixed(2)}s* (threshold: ${ALERT_THRESHOLD_SECONDS}s).\nPayment confirmation times may be degraded.`,
  };

  try {
    await axios.post(webhookUrl, message, { timeout: 5000 });
  } catch (err) {
    console.error("[LedgerMonitor] Failed to send Slack alert:", err);
  }
}

async function sendPagerDutyAlert(avgSeconds: number): Promise<void> {
  const integrationKey = process.env.PAGERDUTY_INTEGRATION_KEY;
  if (!integrationKey) return;

  const dedupKey = `${process.env.PAGERDUTY_DEDUP_KEY || "proxypay"}-stellar-ledger-close-time`;

  const event = {
    routing_key: integrationKey,
    event_action: "trigger",
    dedup_key: dedupKey,
    payload: {
      summary: `Stellar ledger close time ${avgSeconds.toFixed(2)}s exceeds ${ALERT_THRESHOLD_SECONDS}s threshold`,
      timestamp: new Date().toISOString(),
      severity: "warning",
      source: "proxypay-ledger-monitor",
      custom_details: {
        rolling_average_seconds: avgSeconds.toFixed(2),
        threshold_seconds: ALERT_THRESHOLD_SECONDS,
        window_ledgers: ROLLING_WINDOW,
        environment: process.env.NODE_ENV || "development",
      },
    },
  };

  try {
    await axios.post("https://events.pagerduty.com/v2/enqueue", event, {
      timeout: 5000,
    });
  } catch (err) {
    console.error("[LedgerMonitor] Failed to send PagerDuty alert:", err);
  }
}

async function maybeAlert(avgSeconds: number): Promise<void> {
  if (avgSeconds <= ALERT_THRESHOLD_SECONDS) return;

  const now = Date.now();
  if (lastAlertAt !== null && now - lastAlertAt < ALERT_COOLDOWN_MS) return;

  lastAlertAt = now;

  console.warn(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "WARN",
      message: "Stellar ledger close time exceeded threshold",
      rolling_average_seconds: avgSeconds.toFixed(2),
      threshold_seconds: ALERT_THRESHOLD_SECONDS,
      window_ledgers: ROLLING_WINDOW,
    }),
  );

  await Promise.allSettled([sendSlackAlert(avgSeconds), sendPagerDutyAlert(avgSeconds)]);
}

// ---------------------------------------------------------------------------
// Per-ledger processing
// ---------------------------------------------------------------------------

function onLedger(record: HorizonLedgerRecord): void {
  const closedAt = new Date(record.closed_at);

  stellarLedgerSequence.set(record.sequence);

  if (prevClosedAt !== null) {
    const deltaSeconds = (closedAt.getTime() - prevClosedAt.getTime()) / 1000;

    // Only accept positive, sane values (guard against out-of-order events)
    if (deltaSeconds > 0 && deltaSeconds < 120) {
      closeTimes.push(deltaSeconds);
      if (closeTimes.length > ROLLING_WINDOW) {
        closeTimes.shift();
      }

      if (closeTimes.length >= 2) {
        const avg =
          closeTimes.reduce((a, b) => a + b, 0) / closeTimes.length;
        stellarLedgerCloseTimeSeconds.set(avg);

        maybeAlert(avg).catch(() => {
          // fire-and-forget; errors already logged inside maybeAlert
        });
      }
    }
  }

  prevClosedAt = closedAt;
}

// ---------------------------------------------------------------------------
// SSE stream subscription
// ---------------------------------------------------------------------------

/**
 * Opens an SSE connection to the Horizon /ledgers endpoint and pumps events
 * into `onLedger`. Returns a `close()` function that tears down the stream.
 *
 * Uses the first available Horizon URL from the pool. If the stream errors,
 * the caller (the retry loop) will reconnect.
 */
function subscribeToLedgerStream(horizonUrl: string): () => void {
  const url = `${horizonUrl.replace(/\/$/, "")}/ledgers?order=asc&cursor=now`;

  // We use axios with responseType 'stream' to get a raw Node.js Readable.
  // This avoids pulling in an extra EventSource polyfill while reusing the
  // axios instance that already has a timeout/interceptor setup in the project.
  let closed = false;
  const controller = new AbortController();

  (async () => {
    try {
      const response = await axios.get<NodeJS.ReadableStream>(url, {
        responseType: "stream",
        signal: controller.signal,
        headers: { Accept: "text/event-stream" },
        timeout: 0, // long-lived stream — no timeout
      });

      let buffer = "";

      response.data.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // last incomplete line stays in buffer

        let dataPayload = "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            dataPayload = line.slice(6).trim();
          } else if (line === "" && dataPayload) {
            // End of an SSE event block
            try {
              if (dataPayload !== '"hello"' && dataPayload !== '"byebye"') {
                const record = JSON.parse(dataPayload) as HorizonLedgerRecord;
                if (record.sequence && record.closed_at) {
                  onLedger(record);
                }
              }
            } catch {
              // Ignore malformed events
            }
            dataPayload = "";
          }
        }
      });

      response.data.on("error", (err: Error) => {
        if (!closed) {
          console.error("[LedgerMonitor] Stream error:", err.message);
        }
      });

      response.data.on("end", () => {
        if (!closed) {
          console.warn("[LedgerMonitor] Stream ended unexpectedly");
        }
      });
    } catch (err: any) {
      if (!closed && err?.code !== "ERR_CANCELED") {
        console.error("[LedgerMonitor] Failed to open ledger stream:", err?.message);
      }
    }
  })();

  return () => {
    closed = true;
    controller.abort();
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the Stellar ledger close time monitoring service.
 *
 * Subscribes to the Horizon `/ledgers` SSE stream, maintains a rolling
 * average over the last 10 ledgers, exposes it at the `/metrics` endpoint,
 * and fires Slack/PagerDuty alerts when the average exceeds 10 seconds.
 */
export function startLedgerMonitor(): void {
  if (isRunning) return;
  isRunning = true;

  console.log("[LedgerMonitor] Starting Stellar ledger close time monitor...");

  const urls = getHorizonUrls();
  const primaryUrl = urls[0];

  // Retry loop: reconnect on stream termination/error
  const connect = (): void => {
    if (!isRunning) return;

    const closeStream = subscribeToLedgerStream(primaryUrl);
    activeStreamClose = closeStream;

    // Schedule a reconnect check — if the stream drops it will be restarted
    setTimeout(() => {
      if (!isRunning) return;
      // Close current stream and reconnect
      try {
        closeStream();
      } catch {
        // ignore
      }
      connect();
    }, RECONNECT_DELAY_MS + 60_000); // reconnect every ~65s to stay fresh
  };

  connect();
}

/**
 * Stop the ledger monitor (called during graceful shutdown).
 */
export function stopLedgerMonitor(): void {
  isRunning = false;
  if (activeStreamClose) {
    try {
      activeStreamClose();
    } catch {
      // ignore
    }
    activeStreamClose = null;
  }
  console.log("[LedgerMonitor] Stopped.");
}

/**
 * Returns the current rolling average ledger close time in seconds,
 * or null if not enough data has been collected yet.
 */
export function getLedgerCloseTimeAvg(): number | null {
  if (closeTimes.length < 2) return null;
  return closeTimes.reduce((a, b) => a + b, 0) / closeTimes.length;
}
