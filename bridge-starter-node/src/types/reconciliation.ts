/**
 * Types for the provider reconciliation system.
 */

/** Status of a single payout as tracked locally. */
export type PayoutStatus =
  | "pending"
  | "completed"
  | "failed"
  | "mismatched"
  | "missing_local"
  | "missing_remote";

/**
 * Consistency boundary for a read.
 *
 * - `primary`: force the read onto the primary so it observes preceding writes
 *   in the same workflow (read-after-write).
 * - `replica`: allow the read to be served by a read replica.
 */
export type ReadConsistency = "primary" | "replica";

/**
 * Opaque transaction client handle. Query helpers accept this so reads stay
 * inside the caller's transaction boundary instead of opening a new
 * connection (which could be routed to a replica).
 */
export interface TransactionClient {
  /** Marker used to distinguish a transaction client from a pool client. */  readonly __transactionClient: true;
}

/** Options accepted by read helpers to control routing and transaction scope. */
export interface ReadOptions {
  /**
   * Explicit transaction client. When provided, the read runs inside the
   * caller's transaction and is never routed to a replica.
   */
  client?: TransactionClient;
  /**
   * Consistency boundary for the read. Defaults to `replica` when no
   * transaction client is supplied. Read-after-write operations must set
   * this to `primary`.
   */
  consistency?: ReadConsistency;
}

/** A payout record as stored in the local ledger. */
export interface LocalPayoutRecord {
  /** Unique payout / transaction ID. */
  id: string;
  /** Amount in the smallest currency unit (e.g. cents). */
  amount: number;
  /** ISO 4217 currency code. */
  currency: string;
  /** Recipient identifier (phone number, wallet address, etc.). */
  recipient: string;
  /** Current status known locally. */
  status: PayoutStatus;
  /** ISO-8601 timestamp of when the payout was initiated. */
  createdAt: string;
}

/** A payout record as returned by the provider / remote API. */
export interface RemotePayoutRecord {
  id: string;
  amount: number;
  currency: string;
  recipient: string;
  status: string;
  createdAt: string;
}

/** The result of reconciling a single payout. */
export interface ReconciliationEntry {
  payoutId: string;
  localStatus: string | null;
  remoteStatus: string | null;
  localAmount: number | null;
  remoteAmount: number | null;
  match: boolean;
  discrepancy: string | null;
}

/** Aggregated result of a full reconciliation run. */
export interface ReconciliationReport {
  /** ISO-8601 timestamp of when the reconciliation started. */
  reconciledAt: string;
  totalLocal: number;
  totalRemote: number;
  matched: number;
  mismatched: number;
  missingLocal: number;
  missingRemote: number;
  entries: ReconciliationEntry[];
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
