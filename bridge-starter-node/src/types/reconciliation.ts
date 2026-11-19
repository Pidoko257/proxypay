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
