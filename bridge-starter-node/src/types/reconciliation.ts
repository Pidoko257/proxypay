/**
 * Reconciliation domain types.
 *
 * Includes scheduler coordination types used to prevent duplicate scheduled
 * jobs across application replicas (distributed lease + fencing).
 */

export type ReconciliationJobStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface ReconciliationJob {
  id: string;
  name: string;
  status: ReconciliationJobStatus;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

/**
 * Outcome of attempting to acquire a distributed lease for a scheduled job.
 * `skipped` means another replica currently holds a valid lease.
 */
export type SchedulerLeaseOutcome = 'acquired' | 'skipped';

/**
 * A distributed lease held by a single replica for a given scheduled job.
 *
 * `fencingToken` is monotonically increasing per job and must be presented
 * on every renewal/release so a stale holder cannot act after its lease has
 * expired and been re-acquired by another replica.
 */
export interface SchedulerLease {
  jobName: string;
  ownerId: string;
  fencingToken: number;
  acquiredAt: Date;
  expiresAt: Date;
}

export interface SchedulerLeaseAcquisition {
  outcome: SchedulerLeaseOutcome;
  lease?: SchedulerLease;
  /** Present when `outcome` is `skipped`; identifies the current holder. */
  heldBy?: string;
}

/**
 * Recorded scheduler execution event for observability. Both `started` and
 * `skipped` executions are recorded so operators can see contention across
 * replicas.
 */
export type SchedulerExecutionEventType = 'started' | 'skipped';

export interface SchedulerExecutionRecord {
  jobName: string;
  event: SchedulerExecutionEventType;
  ownerId: string;
  fencingToken?: number;
  /** Present when `event` is `skipped`; identifies the lease holder. */
  heldBy?: string;
  recordedAt: Date;
}

/**
 * Shared provider adapter contract.
 *
 * Every supported provider implementation (and its mock / recorded sanitized
 * fixtures) must satisfy this interface so the same contract test suite can
 * run against all of them. It covers authentication, collection, payout,
 * status lookup, callback handling, and batch partial-failure behavior.
 */
export interface ProviderAdapter {
  /** Stable provider identifier (e.g. "mtn", "airtel"). */
  readonly provider: string;

  /** Authenticate against the provider and return a usable session token. */
  authenticate(credentials: ProviderCredentials): Promise<AuthSession>;

  /** Collect (pull) funds from a customer into the provider account. */
  collect(request: CollectionRequest): Promise<CollectionResult>;

  /** Send a payout to a recipient. */
  payout(request: PayoutRequest): Promise<PayoutResult>;

  /** Look up the current status of a previously initiated operation. */
  getStatus(reference: string): Promise<StatusResult>;

  /** Parse and validate an inbound provider callback / webhook payload. */
  handleCallback(payload: unknown): Promise<CallbackResult>;

  /**
   * Execute a batch of payouts. Must not throw on individual failures;
   * instead it returns per-item results so partial failures are observable.
   */
  payoutBatch(requests: PayoutRequest[]): Promise<BatchResult<PayoutResult>>;
}

/** Credentials used to authenticate with a provider. */
export interface ProviderCredentials {
  apiKey: string;
  apiSecret: string;
  /** Optional base URL override (used by mocks / fixtures). */
  baseUrl?: string;
}

/** Result of a successful authentication. */
export interface AuthSession {
  token: string;
  /** ISO-8601 expiry timestamp. */
  expiresAt: string;
}

/** A request to collect funds from a customer. */
export interface CollectionRequest {
  /** Client-generated idempotency reference. */
  reference: string;
  amount: number;
  currency: string;
  recipient: string;
}

/** Result of a collection request. */
export interface CollectionResult {
  reference: string;
  status: PayoutStatus;
  providerReference: string;
}

/** A request to send a payout. */
export interface PayoutRequest {
  /** Client-generated idempotency reference. */
  reference: string;
  amount: number;
  currency: string;
  recipient: string;
}

/** Result of a payout request. */
export interface PayoutResult {
  reference: string;
  status: PayoutStatus;
  providerReference: string;
}

/** Result of a status lookup. */
export interface StatusResult {
  reference: string;
  status: PayoutStatus;
  providerReference: string;
}

/** Result of parsing an inbound callback. */
export interface CallbackResult {
  reference: string;
  status: PayoutStatus;
  /** Whether the callback signature / payload was valid. */
  valid: boolean;
}

/** Per-item outcome within a batch operation. */
export interface BatchItemResult<T> {
  reference: string;
  ok: boolean;
  result: T | null;
  error: string | null;
}

/** Aggregated result of a batch operation, preserving partial failures. */
export interface BatchResult<T> {
  items: BatchItemResult<T>[];
  succeeded: number;
  failed: number;
}
