/**
 * Provider Reconciliation Service
 *
 * Compares local payout records against the provider's remote API to detect
 * discrepancies such as:
 *   - Status mismatches  (local says "completed", provider says "failed")
 *   - Amount mismatches  (rounding / FX differences)
 *   - Missing records    (exists locally but not remotely, or vice-versa)
 *
 * Integrators should supply their own `fetchLocalPayouts` and
 * `fetchRemotePayouts` implementations — the defaults below are stubs
 * that return demo data so the script is runnable out of the box.
 *
 * SEP-31 idempotency helpers (`submitPayoutIdempotent`,
 * `reconcileCompletionCallback`) live here so payout submission and
 * callback handling share the same persisted reference store.
 */

import axios from "axios";
import { config } from "../config/env";
import type {
  LocalPayoutRecord,
  RemotePayoutRecord,
  ReconciliationEntry,
  ReconciliationReport,
} from "../types/reconciliation";

// ─── Per-workload queue policies & backpressure ──────────────────────────────

/**
 * Workloads that share the queue infrastructure but have very different
 * resource and provider constraints.  Each gets its own bounded policy so a
 * burst in one workload cannot starve or overload the others.
 */
export type QueueWorkload = "payment" | "reconciliation" | "notification";

/**
 * Admission behavior applied when a queue is at capacity.
 *
 * - `reject`  : fail fast — the caller must handle the rejection.
 * - `defer`   : hold the job until capacity frees up (bounded wait).
 * - `drop-oldest`: evict the oldest queued job to admit the new one.
 */
export type AdmissionBehavior = "reject" | "defer" | "drop-oldest";

/**
 * Bounded queue policy for a single workload.
 *
 * `concurrency` caps in-flight jobs, `capacity` caps queued (waiting) jobs,
 * and `rateBudget` caps provider calls per rolling window so downstream
 * dependencies are never overwhelmed.
 */
export interface QueuePolicy {
  workload: QueueWorkload;
  concurrency: number;
  capacity: number;
  /** Max provider calls allowed within `rateWindowMs`. */
  rateBudget: number;
  rateWindowMs: number;
  admission: AdmissionBehavior;
  /** Max time a `defer` admission will wait for capacity before rejecting. */
  deferTimeoutMs: number;
}

/**
 * Distinct, bounded policies per workload.
 *
 * - payment:        low concurrency, tight provider budget (money movement).
 * - reconciliation: moderate concurrency, batch-friendly, defers on pressure.
 * - notification:   high concurrency, cheap provider, drops oldest on pressure.
 */
export const QUEUE_POLICIES: Record<QueueWorkload, QueuePolicy> = {
  payment: {
    workload: "payment",
    concurrency: 4,
    capacity: 100,
    rateBudget: 20,
    rateWindowMs: 1_000,
    admission: "reject",
    deferTimeoutMs: 0,
  },
  reconciliation: {
    workload: "reconciliation",
    concurrency: 8,
    capacity: 500,
    rateBudget: 50,
    rateWindowMs: 1_000,
    admission: "defer",
    deferTimeoutMs: 5_000,
  },
  notification: {
    workload: "notification",
    concurrency: 32,
    capacity: 2_000,
    rateBudget: 200,
    rateWindowMs: 1_000,
    admission: "drop-oldest",
    deferTimeoutMs: 0,
  },
};

/** Visible saturation metrics for a single queue. */
export interface QueueMetrics {
  workload: QueueWorkload;
  depth: number;
  capacity: number;
  active: number;
  concurrency: number;
  rejected: number;
  deferred: number;
  dropped: number;
  /** depth / capacity, clamped to [0, 1]. */
  saturation: number;
}

/** Error thrown when a queue rejects admission under backpressure. */
export class QueueSaturatedError extends Error {
  constructor(public readonly workload: QueueWorkload) {
    super(`Queue "${workload}" is saturated and rejected admission`);
    this.name = "QueueSaturatedError";
  }
}

interface QueueState {
  policy: QueuePolicy;
  active: number;
  waiting: Array<() => void>;
  rejected: number;
  deferred: number;
  dropped: number;
  /** Timestamps of provider calls within the current rate window. */
  rateHits: number[];
}

const queueStates = new Map<QueueWorkload, QueueState>();

function getQueueState(workload: QueueWorkload): QueueState {
  let state = queueStates.get(workload);
  if (!state) {
    state = {
      policy: QUEUE_POLICIES[workload],
      active: 0,
      waiting: [],
      rejected: 0,
      deferred: 0,
      dropped: 0,
      rateHits: [],
    };
    queueStates.set(workload, state);
  }
  return state;
}

function pruneRateWindow(state: QueueState, now: number): void {
  const cutoff = now - state.policy.rateWindowMs;
  while (state.rateHits.length > 0 && state.rateHits[0] <= cutoff) {
    state.rateHits.shift();
  }
}

/**
 * Acquire a slot for a job under the workload's bounded policy.
 *
 * Enforces concurrency, queue capacity, provider rate budget, and the
 * configured admission behavior.  Resolves once the job may run; the caller
 * MUST invoke the returned `release` function when the job finishes.
 */
export async function acquireQueueSlot(
  workload: QueueWorkload
): Promise<() => void> {
  const state = getQueueState(workload);
  const { policy } = state;

  // Provider rate budget — wait for the window to free up if exhausted.
  for (;;) {
    const now = Date.now();
    pruneRateWindow(state, now);
    if (state.rateHits.length < policy.rateBudget) {
      state.rateHits.push(now);
      break;
    }
    const waitMs = state.rateHits[0] + policy.rateWindowMs - now;
    await new Promise((resolve) => setTimeout(resolve, Math.max(waitMs, 1)));
  }

  // Concurrency available — run immediately.
  if (state.active < policy.concurrency) {
    state.active += 1;
    return makeRelease(state);
  }

  // At concurrency limit — apply admission behavior against queue capacity.
  const depth = state.waiting.length;
  if (depth >= policy.capacity) {
    if (policy.admission === "drop-oldest" && depth > 0) {
      const evicted = state.waiting.shift();
      state.dropped += 1;
      // The evicted waiter is released so its caller can observe the drop.
      evicted?.();
    } else if (policy.admission === "reject") {
      state.rejected += 1;
      throw new QueueSaturatedError(workload);
    }
  }

  state.deferred += 1;
  return new Promise<() => void>((resolve, reject) => {
    let settled = false;
    const onSlot = () => {
      if (settled) return;
      settled = true;
      state.active += 1;
      resolve(makeRelease(state));
    };
    state.waiting.push(onSlot);

    if (policy.admission === "defer" && policy.deferTimeoutMs > 0) {
      setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = state.waiting.indexOf(onSlot);
        if (idx !== -1) state.waiting.splice(idx, 1);
        state.rejected += 1;
        reject(new QueueSaturatedError(workload));
      }, policy.deferTimeoutMs);
    }
  });
}

function makeRelease(state: QueueState): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.active = Math.max(0, state.active - 1);
    const next = state.waiting.shift();
    if (next) next();
  };
}

/** Snapshot saturation metrics for a single workload queue. */
export function getQueueMetrics(workload: QueueWorkload): QueueMetrics {
  const state = getQueueState(workload);
  const depth = state.waiting.length;
  const capacity = state.policy.capacity;
  return {
    workload,
    depth,
    capacity,
    active: state.active,
    concurrency: state.policy.concurrency,
    rejected: state.rejected,
    deferred: state.deferred,
    dropped: state.dropped,
    saturation: capacity > 0 ? Math.min(depth / capacity, 1) : 0,
  };
}

/** Snapshot saturation metrics for every configured workload queue. */
export function getAllQueueMetrics(): QueueMetrics[] {
  return (Object.keys(QUEUE_POLICIES) as QueueWorkload[]).map(getQueueMetrics);
}

// ─── Transaction / consistency boundary ──────────────────────────────────────

/**
 * Minimal transaction client contract.
 *
 * Callers that already hold an open transaction (or a primary-routed
 * connection) can pass it in so that reads stay inside the caller's
 * transaction and consistency boundary instead of being routed to a
 * possibly-lagging replica.
 */
export interface TransactionClient {
  /** Execute a query against this client's connection. */
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Options controlling where reads are served from.
 *
 * `client` pins reads to the caller's transaction. `primary` forces
 * read-after-write operations onto the primary so replica routing cannot
 * serve stale data.
 */
export interface ReadOptions {
  client?: TransactionClient;
  primary?: boolean;
}

// ─── Data-source adapters (replace with real implementations) ────────────────

/**
 * Fetch payout records from the local data store.
 *
 * Replace this stub with a real database / file query. When `options.client`
 * is supplied the read must run on that client so it observes writes made
 * earlier in the same transaction. When `options.primary` is set the read
 * must be routed to the primary (read-after-write).
 */
export async function fetchLocalPayouts(
  options: ReadOptions = {}
): Promise<LocalPayoutRecord[]> {
  // TODO: Replace with your actual local data source (database, CSV, etc.)
  if (options.client) {
    // Read inside the caller's transaction boundary.
    const { rows } = await options.client.query<LocalPayoutRecord>(
      "SELECT id, status, amount FROM payouts"
    );
    return rows;
  }

  console.log(
    `[reconciler] Fetching local payout records … (primary=${!!options.primary})`
  );
  return [];
}

/**
 * Fetch payout records from the remote provider API.
 *
 * By default this calls `GET <BRIDGE_API_URL>/payouts` using the configured
 * API key.  Adjust the endpoint, pagination, and response mapping to match
 * your provider.
 */
export async function fetchRemotePayouts(): Promise<RemotePayoutRecord[]> {
  console.log("[reconciler] Fetching remote payout records …");

  if (!config.bridgeApiUrl) {
    console.warn(
      "[reconciler] BRIDGE_API_URL is not set — returning empty remote list."
    );
    return [];
  }

  try {
    const response = await axios.get<RemotePayoutRecord[]>(
      `${config.bridgeApiUrl}/payouts`,
      {
        headers: {
          Authorization: `Bearer ${config.bridgeApiKey}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (error: any) {
    console.error(
      "[reconciler] Failed to fetch remote payouts:",
      error.response?.data || error.message
    );
    return [];
  }
}

// ─── SEP-31 idempotent payout submission ─────────────────────────────────────

/**
 * Persisted SEP-31 transaction reference.  The `reference` is the unique
 * idempotency key that must be written *before* any external call so that
 * retries and duplicate callbacks can be reconciled against it.
 */
export interface Sep31PayoutReference {
  reference: string;
  status: "pending" | "submitted" | "completed" | "failed";
  providerPayoutId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * In-memory reference store keyed by the unique SEP-31 reference.
 *
 * In production this should be backed by a database table with a UNIQUE
 * constraint on `reference` (e.g. `UNIQUE(reference)`), so that concurrent
 * submissions of the same reference cannot both proceed.  The Map below
 * enforces the same uniqueness invariant for the starter.
 */
const payoutReferences = new Map<string, Sep31PayoutReference>();

/**
 * Persist a unique SEP-31 transaction reference before any external call.
 *
 * Returns the existing record when the reference was already persisted
 * (idempotent), or a freshly created `pending` record otherwise.  Callers
 * MUST treat a non-`pending` existing record as "already submitted" and
 * avoid re-submitting the payout.
 */
export function persistPayoutReference(
  reference: string
): Sep31PayoutReference {
  const existing = payoutReferences.get(reference);
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const record: Sep31PayoutReference = {
    reference,
    status: "pending",
    providerPayoutId: null,
    createdAt: now,
    updatedAt: now,
  };
  payoutReferences.set(reference, record);
  return record;
}

/**
 * Query the provider status API to determine whether a payout for the given
 * reference already exists.  Used after ambiguous failures (timeouts /
 * unknown responses) to avoid submitting a second payout.
 */
export async function queryProviderPayoutStatus(
  reference: string
): Promise<RemotePayoutRecord | null> {
  if (!config.bridgeApiUrl) {
    return null;
  }

  try {
    const response = await axios.get<RemotePayoutRecord>(
      `${config.bridgeApiUrl}/payouts/${encodeURIComponent(reference)}`,
      {
        headers: {
          Authorization: `Bearer ${config.bridgeApiKey}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (error: any) {
    // 404 means the provider has no record — safe to retry submission.
    if (error.response?.status === 404) {
      return null;
    }
    // Any other failure is ambiguous; surface it so the caller does not
    // blindly retry and risk a duplicate payout.
    throw error;
  }
}

/**
 * Submit a SEP-31 payout idempotently.
 *
 * 1. Persist the unique reference before any external call.
 * 2. If the reference was already submitted/completed, return the stored
 *    record instead of submitting again.
 * 3. On ambiguous failure, query the provider status API before retrying.
 */
export async function submitPayoutIdempotent(
  reference: string,
  submit: (reference: string) => Promise<RemotePayoutRecord>
): Promise<Sep31PayoutReference> {
  const record = persistPayoutReference(reference);

  // Already submitted or completed — do not submit a second payout.
  if (record.status === "submitted" || record.status === "completed") {
    return record;
  }

  try {
    const remote = await submit(reference);
    record.status = "submitted";
    record.providerPayoutId = remote.id;
    record.updatedAt = new Date().toISOString();
    payoutReferences.set(reference, record);
    return record;
  } catch (error) {
    // Ambiguous failure: check whether the provider already has the payout.
    const remote = await queryProviderPayoutStatus(reference);
    if (remote) {
      record.status = "submitted";
      record.providerPayoutId = remote.id;
      record.updatedAt = new Date().toISOString();
      payoutReferences.set(reference, record);
      return record;
    }
    throw error;
  }
}

/**
 * Reconcile a completion callback against the persisted reference.
 *
 * Duplicate or out-of-order callbacks are matched to the existing record so
 * they never create a second payout.  Returns th

/* … truncated 4166 chars — edit only what you need near the top … */
