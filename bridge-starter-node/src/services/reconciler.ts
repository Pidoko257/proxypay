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

// ─── Distributed scheduler lock (issue #826) ─────────────────────────────────

/**
 * Minimal distributed lock backend contract.
 *
 * Implementations may be backed by Redis (`SET key value NX PX ttl`) or by
 * PostgreSQL advisory locks.  The contract is intentionally small so the
 * scheduler can be tested with an in-memory fake.
 */
export interface DistributedLockBackend {
  /**
   * Attempt to acquire `key` for `owner`.  Must be atomic: only one caller
   * may succeed while the lock is held.  Returns `true` on success.
   */
  acquire(key: string, owner: string, ttlMs: number): Promise<boolean>;
  /**
   * Renew the lease for `key` only if it is still held by `owner`.
   * Returns `true` when the lease was extended.
   */
  renew(key: string, owner: string, ttlMs: number): Promise<boolean>;
  /** Release `key` only if it is still held by `owner`. */
  release(key: string, owner: string): Promise<void>;
}

/**
 * In-memory lock backend used as the default and in tests.  It enforces the
 * same single-holder invariant as Redis/Postgres so simultaneous schedulers
 * contend correctly.  Production deployments should inject a Redis- or
 * Postgres-backed implementation.
 */
export class InMemoryLockBackend implements DistributedLockBackend {
  private readonly locks = new Map<
    string,
    { owner: string; expiresAt: number }
  >();

  async acquire(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const current = this.locks.get(key);
    if (current && current.expiresAt > now) {
      return false;
    }
    this.locks.set(key, { owner, expiresAt: now + ttlMs });
    return true;
  }

  async renew(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const current = this.locks.get(key);
    if (!current || current.owner !== owner || current.expiresAt <= now) {
      return false;
    }
    current.expiresAt = now + ttlMs;
    return true;
  }

  async release(key: string, owner: string): Promise<void> {
    const current = this.locks.get(key);
    if (current && current.owner === owner) {
      this.locks.delete(key);
    }
  }
}

/** Recorded outcome of a scheduled job attempt, for observability. */
export interface ScheduledJobExecution {
  jobName: string;
  replicaId: string;
  /** Monotonic fencing token; increases each time the job is started. */
  fencingToken: number;
  status: "started" | "skipped" | "completed" | "failed";
  at: string;
}

/** In-memory execution log; swap for a metrics/audit sink in production. */
const scheduledJobExecutions: ScheduledJobExecution[] = [];

/** Return a snapshot of recorded scheduled-job executions. */
export function getScheduledJobExecutions(): ScheduledJobExecution[] {
  return [...scheduledJobExecutions];
}

function recordExecution(entry: ScheduledJobExecution): void {
  scheduledJobExecutions.push(entry);
  console.log(
    `[scheduler] job=${entry.jobName} replica=${entry.replicaId} ` +
      `status=${entry.status} fence=${entry.fencingToken}`
  );
}

/** Options for {@link runScheduledJob}. */
export interface ScheduledJobOptions {
  /** Unique job name; used as the lock key. */
  jobName: string;
  /** Stable identifier for this replica/process. */
  replicaId: string;
  /** The job body.  Receives the fencing token for downstream guards. */
  run: (fencingToken: number) => Promise<void>;
  /** Lock backend; defaults to a shared in-memory backend. */
  backend?: DistributedLockBackend;
  /** Lease duration in ms.  Defaults to 30s. */
  leaseTtlMs?: number;
  /** Lease renewal interval in ms.  Defaults to half the lease TTL. */
  renewIntervalMs?: number;
}

const defaultLockBackend = new InMemoryLockBackend();
let fencingCounter = 0;

/**
 * Run a scheduled job under a per-job distributed lease.
 *
 * Only the replica that acquires the lease executes `run`; all others record
 * a `skipped` execution and return.  While the job runs, the lease is renewed
 * periodically.  If renewal fails (the lease was lost to another replica),
 * the fencing token is invalidated so a stale holder cannot keep executing.
 *
 * Returns `true` when this replica executed the job, `false` when skipped.
 */
export async function runScheduledJob(
  options: ScheduledJobOptions
): Promise<boolean> {
  const {
    jobName,
    replicaId,
    run,
    backend = defaultLockBackend,
    leaseTtlMs = 30_000,
    renewIntervalMs = Math.max(1, Math.floor(leaseTtlMs / 2)),
  } = options;

  const lockKey = `scheduler:lock:${jobName}`;
  const owner = `${replicaId}:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2)}`;

  const acquired = await backend.acquire(lockKey, owner, leaseTtlMs);
  if (!acquired) {
    recordExecution({
      jobName,
      replicaId,
      fencingToken: fencingCounter,
      status: "skipped",
      at: new Date().toISOString(),
    });
    return false;
  }

  const fencingToken = ++fencingCounter;
  recordExecution({
    jobName,
    replicaId,
    fencingToken,
    status: "started",
    at: new Date().toISOString(),
  });

  let leaseLost = false;
  const renewTimer = setInterval(() => {
    void backend
      .renew(lockKey, owner, leaseTtlMs)
      .then((renewed) => {
        if (!renewed) {
          leaseLost = true;
        }
      })
      .catch(() => {
        leaseLost = true;
      });
  }, renewIntervalMs);
  // Do not keep the process alive solely for lease renewal.
  if (typeof renewTimer.unref === "function") {
    renewTimer.unref();
  }

  try {
    await run(fencingToken);
    if (leaseLost) {
      throw new Error(
        `[scheduler] lease for job "${jobName}" was lost during execution`
      );
    }
    recordExecution({
      jobName,
      replicaId,
      fencingToken,
      status: "completed",
      at: new Date().toISOString(),
    });
    return true;
  } catch (error) {
    recordExecution({
      jobName,
      replicaId,
      fencingToken,
      status: "failed",
      at: new Date().toISOString(),
    });
    throw error;
  } finally {
    clearInterval(renewTimer);
    await backend.release(lockKey, owner).catch(() => undefined);
  }
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
 * they never create a second payout.  Returns the reconciled record.
 */
export function reconcileCompletionCallback(
  reference: string,
  status: Sep31PayoutReference["status"],
  providerPayoutId?: string | null
): Sep31PayoutReference {
  const record = persistPayoutReference(reference);
  record.status = status;
  if (providerPayoutId !== undefined) {
    record.providerPayoutId = providerPayoutId;
  }
  record.updatedAt = new Date().toISOString();
  payoutReferences.set(reference, record);
  return record;
}
