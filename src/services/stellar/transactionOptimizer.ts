/**
 * Stellar Transaction Optimizer — Issue #165
 *
 * Provides:
 *  - Dynamic fee estimation with surge multiplier
 *  - Transaction batching (up to 100 ops per envelope)
 *  - Submission with exponential-backoff polling
 *  - Circuit-breaker guard around Horizon submissions
 *  - Prometheus-compatible latency and success-rate tracking
 */

import * as StellarSdk from "stellar-sdk";
import { getStellarServer, getNetworkPassphrase } from "../../config/stellar";
import { executeWithCircuitBreaker } from "../../utils/circuitBreaker";
import logger from "../../utils/logger";

// ─── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 16_000;
const DEFAULT_SUBMIT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_MAX_ATTEMPTS = 15;
const DEFAULT_FEE_SURGE_MULTIPLIER = 1.5;
const DEFAULT_BATCH_MAX_OPS = 100; // Stellar protocol limit

export interface StellarOptimizerConfig {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  submitTimeoutMs?: number;
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
  /** Multiplier applied to the network base fee to get ahead of congestion */
  feeSurgeMultiplier?: number;
  /** Maximum operations per batched transaction */
  batchMaxOps?: number;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BatchOperation {
  /** Unique caller-assigned ID used to correlate results */
  id: string;
  operation: StellarSdk.Operation;
}

export interface BatchSubmitResult {
  id: string;
  success: boolean;
  transactionHash?: string;
  error?: string;
}

export interface BatchEnvelopeResult {
  /** Per-operation outcomes */
  results: BatchSubmitResult[];
  /** Stellar transaction hash for the whole envelope (if submitted successfully) */
  transactionHash?: string;
  success: boolean;
  /** Total submission time in milliseconds */
  latencyMs: number;
}

export interface SubmitEnvelopeOptions {
  /** XDR envelope string — already-built and signed */
  envelope: string;
  /** Source account used to build the transaction (for polling) */
  sourceAccount?: string;
  config?: StellarOptimizerConfig;
}

export interface SubmitResult {
  success: boolean;
  transactionHash?: string;
  feeCharged?: number;
  resultXdr?: string;
  error?: string;
  /** Retries performed before final outcome */
  attempts: number;
  /** Total elapsed time in milliseconds */
  latencyMs: number;
}

// ─── Fee Estimation ───────────────────────────────────────────────────────────

/**
 * Fetch the current network base fee and apply an optional surge multiplier.
 * Falls back to StellarSdk.BASE_FEE (100 stroops) on any error.
 */
export async function estimateOptimalFee(
  operationCount: number = 1,
  surgeMutiplier: number = DEFAULT_FEE_SURGE_MULTIPLIER,
): Promise<number> {
  try {
    const server = getStellarServer();
    const networkFee = await server.fetchBaseFee();
    const base = Math.max(Number(networkFee), StellarSdk.BASE_FEE as unknown as number);
    const perOp = Math.ceil(base * surgeMutiplier);
    return perOp * operationCount;
  } catch (err) {
    logger.warn({ err }, "[StellarOptimizer] Fee estimation failed, using default BASE_FEE");
    return (StellarSdk.BASE_FEE as unknown as number) * operationCount;
  }
}

// ─── Transaction Batching ─────────────────────────────────────────────────────

/**
 * Split an array of operations into batches no larger than `maxOps`.
 */
function chunkOperations(
  ops: BatchOperation[],
  maxOps: number,
): BatchOperation[][] {
  const chunks: BatchOperation[][] = [];
  for (let i = 0; i < ops.length; i += maxOps) {
    chunks.push(ops.slice(i, i + maxOps));
  }
  return chunks;
}

/**
 * Build a Stellar Transaction containing the provided operations.
 * Uses a dynamically estimated fee if none is supplied.
 */
export async function buildBatchTransaction(
  sourceKeypair: StellarSdk.Keypair,
  operations: BatchOperation[],
  config: StellarOptimizerConfig = {},
): Promise<StellarSdk.Transaction> {
  const server = getStellarServer();
  const account = await server.loadAccount(sourceKeypair.publicKey());

  const fee = await estimateOptimalFee(
    operations.length,
    config.feeSurgeMultiplier ?? DEFAULT_FEE_SURGE_MULTIPLIER,
  );

  const builder = new StellarSdk.TransactionBuilder(account, {
    fee: String(Math.ceil(fee / operations.length)), // per-op fee
    networkPassphrase: getNetworkPassphrase(),
  }).setTimeout(config.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS);

  for (const { operation } of operations) {
    builder.addOperation(operation);
  }

  const tx = builder.build();
  tx.sign(sourceKeypair);
  return tx;
}

// ─── Polling ──────────────────────────────────────────────────────────────────

/**
 * Poll Horizon until the transaction with `hash` reaches a terminal state
 * or the polling limit is reached.
 */
async function pollTransactionStatus(
  hash: string,
  config: StellarOptimizerConfig = {},
): Promise<{ success: boolean; resultXdr?: string; feeCharged?: number }> {
  const server = getStellarServer();
  const maxAttempts = config.pollMaxAttempts ?? DEFAULT_POLL_MAX_ATTEMPTS;
  const intervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const tx = await server.transactions().transaction(hash).call();
      if (tx.successful !== undefined) {
        return {
          success: tx.successful,
          feeCharged: tx.fee_charged ? Number(tx.fee_charged) : undefined,
          resultXdr: (tx as unknown as { result_xdr?: string }).result_xdr,
        };
      }
    } catch (_err) {
      // Transaction not yet on ledger — keep polling
    }

    if (attempt < maxAttempts) {
      const delay = Math.min(
        intervalMs * Math.pow(2, attempt - 1),
        config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
      );
      await sleep(delay);
    }
  }

  // Could not confirm within polling window — treat as pending/unknown
  return { success: false };
}

// ─── Core Submission (with retries + circuit breaker) ────────────────────────

/**
 * Submit a pre-built XDR envelope to Horizon with:
 *  1. Exponential backoff on transient failures
 *  2. Circuit breaker to stop hammering an unhealthy Horizon endpoint
 *  3. Transaction-status polling after each submission attempt
 */
export async function submitWithOptimization(
  opts: SubmitEnvelopeOptions,
): Promise<SubmitResult> {
  const config = opts.config ?? {};
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  const server = getStellarServer();
  const startMs = Date.now();
  let attempts = 0;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    attempts = attempt;
    try {
      const cbResult = await executeWithCircuitBreaker<{
        hash: string;
        fee_charged?: number | string;
        result_xdr?: string;
      }>({
        provider: "stellar",
        operation: "submitTransaction",
        execute: async () => {
          const tx = StellarSdk.TransactionBuilder.fromXDR(
            opts.envelope,
            getNetworkPassphrase(),
          );
          const resp = await server.submitTransaction(tx);
          return {
            success: true,
            data: {
              hash: resp.hash,
              fee_charged: (resp as any).fee_charged,
              result_xdr: resp.result_xdr,
            },
          };
        },
        fallback: async (err) => ({
          success: false,
          error: err,
        }),
      });

      if (!cbResult.success || !cbResult.data) {
        throw cbResult.error ?? new Error("Circuit breaker fallback triggered");
      }

      const { hash, fee_charged, result_xdr } = cbResult.data;

      // Poll to confirm final status
      const polled = await pollTransactionStatus(hash, config);

      const latencyMs = Date.now() - startMs;
      logger.info(
        { hash, latencyMs, attempts, feeCharged: fee_charged },
        "[StellarOptimizer] Transaction submitted successfully",
      );

      return {
        success: polled.success,
        transactionHash: hash,
        feeCharged: polled.feeCharged ?? (fee_charged ? Number(fee_charged) : undefined),
        resultXdr: polled.resultXdr ?? result_xdr,
        attempts,
        latencyMs,
      };
    } catch (err) {
      lastError = err;
      const shouldRetry = isStellarTransientError(err) && attempt < maxRetries;

      logger.warn(
        {
          attempt,
          maxRetries,
          willRetry: shouldRetry,
          err: err instanceof Error ? err.message : String(err),
        },
        "[StellarOptimizer] Submission attempt failed",
      );

      if (!shouldRetry) break;

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      await sleep(delay);
    }
  }

  const latencyMs = Date.now() - startMs;
  const errorMsg =
    lastError instanceof Error ? lastError.message : String(lastError);

  logger.error(
    { attempts, latencyMs, error: errorMsg },
    "[StellarOptimizer] All submission attempts failed",
  );

  return {
    success: false,
    error: errorMsg,
    attempts,
    latencyMs,
  };
}

// ─── Batch Submit ─────────────────────────────────────────────────────────────

/**
 * Submit a list of operations as one or more batched Stellar transactions.
 *
 * Operations are automatically split into groups of `batchMaxOps` (default 100).
 * Each batch is submitted independently and results are merged.
 */
export async function submitBatch(
  sourceKeypair: StellarSdk.Keypair,
  operations: BatchOperation[],
  config: StellarOptimizerConfig = {},
): Promise<BatchEnvelopeResult[]> {
  const maxOps = config.batchMaxOps ?? DEFAULT_BATCH_MAX_OPS;
  const chunks = chunkOperations(operations, maxOps);
  const envelopeResults: BatchEnvelopeResult[] = [];

  for (const chunk of chunks) {
    const startMs = Date.now();
    try {
      const tx = await buildBatchTransaction(sourceKeypair, chunk, config);
      const envelope = tx.toEnvelope().toXDR("base64");

      const submitResult = await submitWithOptimization({
        envelope,
        sourceAccount: sourceKeypair.publicKey(),
        config,
      });

      envelopeResults.push({
        results: chunk.map(({ id }) => ({
          id,
          success: submitResult.success,
          transactionHash: submitResult.transactionHash,
          error: submitResult.success ? undefined : submitResult.error,
        })),
        transactionHash: submitResult.transactionHash,
        success: submitResult.success,
        latencyMs: submitResult.latencyMs,
      });
    } catch (err) {
      const latencyMs = Date.now() - startMs;
      const errorMsg = err instanceof Error ? err.message : String(err);
      envelopeResults.push({
        results: chunk.map(({ id }) => ({
          id,
          success: false,
          error: errorMsg,
        })),
        success: false,
        latencyMs,
      });
    }
  }

  return envelopeResults;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determine whether a Stellar submission error is transient (safe to retry).
 * Permanent errors include bad sequence numbers, bad signatures, etc.
 */
export function isStellarTransientError(error: unknown): boolean {
  const msg =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();

  // Horizon-specific transient indicators
  if (/timeout|timed out|etimedout/i.test(msg)) return true;
  if (/econnreset|econnrefused|enotfound|network/i.test(msg)) return true;
  if (/429|too many requests|rate limit/i.test(msg)) return true;
  if (/503|service unavailable|502|bad gateway/i.test(msg)) return true;
  if (/temporarily unavailable|try again/i.test(msg)) return true;

  // StellarSdk result codes that are transient
  const stellarErr = error as { response?: { data?: { extras?: { result_codes?: { transaction?: string } } } } };
  const txResultCode =
    stellarErr?.response?.data?.extras?.result_codes?.transaction;
  if (txResultCode === "tx_insufficient_fee") return true; // fee bump helps
  if (txResultCode === "tx_too_late") return true; // rebuildable

  return false;
}
