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
 *
 * ─── Reconciliation Operations Runbook (issue #842) ─────────────────────────
 *
 * This section documents the safe operational procedure for support staff
 * investigating reconciliation alerts.  It is intentionally read-only: no
 * step below authorizes manually mutating financial state (payout status,
 * amounts, or balances).  All corrections flow through the approval workflow
 * described at the end.
 *
 * 1. Alert meanings
 *    - `status_mismatch`: local and provider disagree on payout status
 *      (e.g. local "completed" vs provider "failed"). Investigate before
 *      assuming either side is correct.
 *    - `amount_mismatch`: settled amount differs from the local amount,
 *      usually due to rounding or FX. Confirm the FX rate snapshot used.
 *    - `missing_remote`: a local payout has no matching provider record.
 *      Could be a submission that never reached the provider.
 *    - `missing_local`: the provider reports a payout we have no local
 *      record for. Treat as potentially fraudulent until proven otherwise.
 *    - `critical`: any alert flagged critical (large amount deltas, repeated
 *      failures, or `missing_local`) must be escalated immediately per §6.
 *
 * 2. Retrieving provider reports
 *    - Open the provider reconciliation dashboard and export the report for
 *      the affected settlement window (UTC date range).
 *    - Cross-reference the exported report against the local reconciliation
 *      report produced by `runReconciliation` (see below).
 *    - Attach both exports to the incident ticket; never edit them.
 *
 * 3. Safe review actions (no financial mutation)
 *    - Read local and remote records, exports, and the audit trail.
 *    - Re-run reconciliation in read-only mode to confirm the discrepancy.
 *    - Add notes and evidence to the incident ticket.
 *    - Do NOT edit payout status, amounts, or balances directly.
 *
 * 4. Correction approval workflow
 *    - A proposed correction must include: the alert id, both report
 *      exports, the audit-trail excerpt, and the proposed new state.
 *    - Approval requires sign-off from the on-call finance owner AND a
 *      second reviewer (four-eyes principle).
 *    - Only after approval may an authorized operator apply the correction
 *      through the audited correction tooling (never by hand).
 *
 * 5. Replay procedure
 *    - Replays are idempotent: re-submitting an existing reference returns
 *      the stored record (see `submitPayoutIdempotent`).
 *    - Before replaying, confirm via `queryProviderPayoutStatus` that the
 *      provider has no record for the reference.
 *    - Record the replay in the audit trail with the incident ticket id.
 *
 * 6. Escalation ownership
 *    - `critical` alerts: page the on-call finance owner immediately.
 *    - `missing_local`: escalate to the security on-call in parallel.
 *    - Non-critical mismatches: assign to the reconciliation queue owner
 *      during business hours.
 * ────────────────────────────────────────────────────────────────────────────
 */

import axios from "axios";
import { config } from "../config/env";
import type {
  LocalPayoutRecord,
  RemotePayoutRecord,
  ReconciliationEntry,
  ReconciliationReport,
} from "../types/reconciliation";

// ─── Injectable clock / randomness providers ─────────────────────────────────

/**
 * Clock provider.  Returns the current time in milliseconds since the epoch.
 *
 * Injecting this (instead of calling `Date.now()` directly) lets tests drive
 * expiry / replay windows deterministically with Jest fake timers.
 */
export interface Clock {
  now(): number;
}

/**
 * Randomness provider.  Returns a float in `[0, 1)`.
 *
 * Injecting this (instead of calling `Math.random()` directly) lets tests
 * exercise jitter and probabilistic / threshold decisions with deterministic
 * stubs.
 */
export interface RandomSource {
  random(): number;
}

/** Default clock backed by the global `Date.now()`. */
export const systemClock: Clock = {
  now: () => Date.now(),
};

/** Default randomness source backed by the global `Math.random()`. */
export const systemRandom: RandomSource = {
  random: () => Math.random(),
};

/**
 * Policy dependencies for retry / fraud logic.  Both providers default to the
 * system implementations so existing callers keep their current behavior.
 */
export interface PolicyDeps {
  clock?: Clock;
  random?: RandomSource;
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

// ─── Transaction status workflow boundary (issue #844) ───────────────────────

/**
 * Canonical transaction statuses.  Every status change in the system — API
 * handlers, workers, provider callbacks, reconciliation, and reversal
 * services — must flow through `TransactionStatusWorkflowService` so that
 * the allowed-transition matrix below cannot be bypassed.
 */
export type TransactionStatus =
  | "pending"
  | "submitted"
  | "completed"
  | "failed"
  | "reversed";

/**
 * Explicit allowed-transition matrix.  A transition not listed here is
 * rejected by the workflow service.  Terminal states (`completed`,
 * `failed`, `reversed`) have no outgoing transitions.
 */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<TransactionStatus, readonly TransactionStatus[]>
> = {
  pending: ["submitted", "failed"],
  submitted: ["completed", "failed"],
  completed: ["reversed"],
  failed: [],
  reversed: [],
};

/** Actor/source metadata recorded on every status change. */
export interface StatusTransitionContext {
  /** Who initiated the change (user id, service name, "system", …). */
  actor: string;
  /** Where the change originated ("api", "worker", "callback", …). */
  source: string;
  /** Optional correlation id for tracing across services. */
  correlationId?: string;
  /** Optional human-readable reason for the change. */
  reason?: string;
}

/** Audit event emitted for every accepted status change. */
export interface StatusTransitionEvent {
  transactionId: string;
  from: TransactionStatus;
  to: TransactionStatus;
  actor: string;
  source: string;
  correlationId?: string;
  reason?: string;
  /** True when the transition was a no-op because the status already matched. */
  idempotent: boolean;
  occurredAt: string;
}

/** Raised when a transition is not permitted by the matrix. */
export class InvalidStatusTransitionError extends Error {
  constructor(
    public readonly transactionId: string,
    public readonly from: TransactionStatus,
    public readonly to: TransactionStatus
  ) {
    super(
      `Invalid transaction status transition for ${transactionId}: ${from} -> ${to}`
    );
    this.name = "InvalidStatusTransitionError";
  }
}

/**
 * Central workflow boundary for transaction status changes.
 *
 * Responsibilities:
 *   - Enforce the `ALLOWED_TRANSITIONS` matrix (reject invalid transitions).
 *   - Record actor/source metadata on every change.
 *   - Provide idempotency: re-applying the current status is a safe no-op.
 *   - Emit audit events for every accepted (or idempotent) change.
 *
 * The store is pluggable so production can back it with PostgreSQL while
 * tests can use the in-memory default.
 */
export interface TransactionStatusStore {
  getStatus(transactionId: string): Promise<TransactionStatus | null>;
  setStatus(
    transactionId: string,
    status: TransactionStatus,
    event: StatusTransitionEvent
  ): Promise<void>;
}

/** In-memory store used by default and by state-machine tests. */
export class InMemoryTransactionStatusStore implements TransactionStatusStore {
  private readonly statuses = new Map<string, TransactionStatus>();
  readonly auditLog: StatusTransitionEvent[] = [];

  async getStatus(transactionId: string): Promise<TransactionStatus | null> {
    return this.statuses.get(transactionId) ?? null;
  }

  async setStatus(
    transactionId: string,
    status: TransactionStatus,
    event: StatusTransitionEvent
  ): Promise<void> {
    this.statuses.set(transactionId, status);
    this.auditLog.push(event);
  }
}

export class TransactionStatusWorkflowService {
  constructor(
    private readonly store: TransactionStatusStore = new InMemoryTransactionStatusStore(),
    private readonly onEvent: (event: StatusTransitionEvent) => void = () => {}
  ) {}

  /**
   * Apply a status transition, enforcing the matrix and idempotency.
   *
   * - If the transaction is already in `to`, this is a safe no-op that still
   *   emits an idempotent audit event.
   * - If the transition is not allowed, throws `InvalidStatusTransitionError`.
   */
  async transition(
    transactionId: string,
    to: TransactionStatus,
    context: StatusTransitionContext
  ): Promise<StatusTransitionEvent> {
    const from = await this.store.getStatus(transactionId);

    if (from === to) {
      const event: StatusTransitionEvent = {
        transactionId,
        from: to,
        to,
        actor: context.actor,
        source: context.source,
        correlationId: context.correlationId,
        reason: context.reason,
        idempotent: true,
        occurredAt: new Date().toISOString(),
      };
      this.onEvent(event);
      return event;
    }

    if (from !== null && !ALLOWED_TRANSITIONS[from].includes(to)) {
      throw new InvalidStatusTransitionError(transactionId, from, to);
    }

    const event: StatusTransitionEvent = {
      transactionId,
      from: from ?? "pending",
      to,
      actor: context.actor,
      source: context.source,
      correlationId: context.correlationId,
      reason: context.reason,
      idempotent: false,
      occurredAt: new Date().toISOString(),
    };

    await this.store.setStatus(transactionId, to, event);
    this.onEvent(event);
    return event;
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
 * MUST treat a non-`pending` existing record as already in flight and must
 * not re-submit it.
 */
export async function persistPayoutReference(
  reference: string
): Promise<Sep31PayoutReference> {
  const existing = payoutReferences.get(reference);
  if (existing) {
    return existing;
  }

  const clock = deps.clock ?? systemClock;
  const now = new Date(clock.now()).toISOString();
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
