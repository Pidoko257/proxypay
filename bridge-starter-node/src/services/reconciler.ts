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

// ─── Reporting timezone / date boundaries ────────────────────────────────────

/**
 * Reporting timezone persisted per merchant/provider (IANA name, e.g.
 * "America/New_York").  Report and reconciliation boundaries are derived from
 * this zone rather than from application time or date strings.
 */
export interface ReportingTimezone {
  merchantId: string;
  timezone: string;
}

/**
 * Half-open UTC interval `[startUtc, endUtc)` covering the given calendar day
 * in the merchant's reporting timezone.  `endUtc` is exclusive so records at
 * exactly midnight of the next day are not double-counted.
 */
export interface UtcInterval {
  startUtc: Date;
  endUtc: Date;
}

/**
 * In-memory reporting-timezone store keyed by merchant id.
 *
 * In production this should be backed by a `reporting_timezone` column on the
 * merchant/provider table.  The Map below mirrors that persistence for the
 * starter and keeps the lookup synchronous.
 */
const reportingTimezones = new Map<string, string>();

/** Persist the reporting timezone for a merchant/provider. */
export function setReportingTimezone(
  merchantId: string,
  timezone: string
): ReportingTimezone {
  // Validate the IANA zone eagerly so bad config fails at write time.
  new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  reportingTimezones.set(merchantId, timezone);
  return { merchantId, timezone };
}

/** Read the persisted reporting timezone, defaulting to UTC. */
export function getReportingTimezone(merchantId: string): string {
  return reportingTimezones.get(merchantId) ?? "UTC";
}

/**
 * Offset (ms) of `timeZone` from UTC at the given instant, accounting for
 * daylight-saving transitions.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second")
  );
  return asUtc - instant.getTime();
}

/**
 * Convert a wall-clock date/time in `timeZone` to the corresponding UTC
 * instant.  Handles DST by resolving the offset at the target instant.
 */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  timeZone: string
): Date {
  // First guess: treat the wall clock as if it were UTC.
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  // Resolve the offset at the guess, then correct once for DST edges.
  const offset = zoneOffsetMs(new Date(guess), timeZone);
  const corrected = guess - offset;
  const offset2 = zoneOffsetMs(new Date(corrected), timeZone);
  return new Date(guess - offset2);
}

/**
 * Compute the half-open UTC interval for a calendar day (`YYYY-MM-DD`) in the
 * merchant's reporting timezone.  This replaces date-string / application-time
 * boundary logic in statement and tax report calculations.
 */
export function getReportingDayInterval(
  merchantId: string,
  date: string
): UtcInterval {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new Error(`Invalid report date "${date}" — expected YYYY-MM-DD`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timeZone = getReportingTimezone(merchantId);

  const startUtc = zonedTimeToUtc(year, month, day, timeZone);
  // Next calendar day in the same zone; Date.UTC normalizes month/year rollover.
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const endUtc = zonedTimeToUtc(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    timeZone
  );

  return { startUtc, endUtc };
}

/**
 * Compute the half-open UTC interval covering an inclusive date range
 * (`from`..`to`, both `YYYY-MM-DD`) in the merchant's reporting timezone.
 */
export function getReportingRangeInterval(
  merchantId: string,
  from: string,
  to: string
): UtcInterval {
  const start = getReportingDayInterval(merchantId, from);
  const end = getReportingDayInterval(merchantId, to);
  return { startUtc: start.startUtc, endUtc: end.endUtc };
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
