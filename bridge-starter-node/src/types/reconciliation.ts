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
 * Reconciliation operations runbook.
 *
 * Support staff use this reference to interpret reconciliation alerts and to
 * investigate discrepancies safely. It is intentionally data-only: it never
 * mutates financial state. Corrections and replays always go through the
 * approval workflow described below.
 */
export interface ReconciliationRunbook {
  /** Human-readable title of the runbook. */
  title: string;
  /** Meaning of each reconciliation alert type. */
  alerts: ReconciliationAlertDoc[];
  /** How to retrieve provider reconciliation reports. */
  reportRetrieval: ReportRetrievalDoc;
  /** Safe, read-only review actions support staff may take. */
  reviewActions: ReviewActionDoc[];
  /** Correction approval workflow. */
  correctionApproval: CorrectionApprovalDoc;
  /** Replay procedure for re-running reconciliation. */
  replayProcedure: ReplayProcedureDoc;
  /** Escalation ownership. */
  escalation: EscalationDoc;
}

/** Documentation for a single reconciliation alert type. */
export interface ReconciliationAlertDoc {
  /** Alert identifier as emitted by the reconciliation job. */
  alertType: string;
  /** What the alert means in plain language. */
  meaning: string;
  /** Typical causes support staff should consider. */
  likelyCauses: string[];
  /** Safe first steps to investigate. */
  firstSteps: string[];
}

/** How to retrieve provider reconciliation reports. */
export interface ReportRetrievalDoc {
  /** Where the provider reconciliation dashboard lives. */
  dashboard: string;
  /** Steps to export / download the provider report. */
  steps: string[];
  /** Notes on matching report periods to local reconciliation runs. */
  notes: string[];
}

/** A safe, read-only review action. */
export interface ReviewActionDoc {
  /** Short name of the action. */
  action: string;
  /** What the action does and why it is safe. */
  description: string;
  /** Explicitly forbidden manual changes during investigation. */
  forbidden: string[];
}

/** Correction approval workflow. */
export interface CorrectionApprovalDoc {
  /** Who must approve a correction. */
  approvers: string[];
  /** Evidence required before a correction is approved. */
  requiredEvidence: string[];
  /** Ordered steps of the approval workflow. */
  steps: string[];
}

/** Replay procedure for re-running reconciliation. */
export interface ReplayProcedureDoc {
  /** Preconditions that must hold before replaying. */
  preconditions: string[];
  /** Ordered replay steps. */
  steps: string[];
  /** How to verify the replay succeeded. */
  verification: string[];
}

/** Escalation ownership. */
export interface EscalationDoc {
  /** Owner responsible for each escalation tier. */
  owners: EscalationOwner[];
  /** When to escalate. */
  triggers: string[];
}

/** A single escalation tier and its owner. */
export interface EscalationOwner {
  /** Tier name (e.g. "L1 support", "payments on-call"). */
  tier: string;
  /** Team or role that owns the tier. */
  owner: string;
  /** Response expectation for the tier. */
  responsibility: string;
}
