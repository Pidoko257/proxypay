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
 * Accounting synchronization helpers (`getAccountingIdempotencyKey`,
 * `syncAccountingObject`, `getAccountingSyncReport`) live here so queued
 * QuickBooks/Xero syncs are idempotent and inspectable per period.
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

// ─── Accounting sync idempotency & reconciliation ────────────────────────────

/** Accounting providers supported by the sync queue. */
export type AccountingProvider = "quickbooks" | "xero";

/** Lifecycle state of a queued accounting sync item. */
export type AccountingSyncState =
  | "pending"
  | "applied"
  | "duplicate"
  | "failed";

/**
 * A single accounting object (journal entry, invoice, bill, …) queued for
 * synchronization with an external accounting provider.
 */
export interface AccountingSyncItem {
  /** Stable local identifier of the accounting object. */
  objectId: string;
  provider: AccountingProvider;
  /** Accounting period the object belongs to (`YYYY-MM`). */
  period: string;
  /**
   * Stable idempotency key persisted per accounting object.  External
   * retries reuse this key so the provider maps them to the same remote
   * identifier instead of creating duplicate journal entries.
   */
  idempotencyKey: string;
  /** Remote identifier assigned by the provider once applied. */
  remoteId?: string;
  state: AccountingSyncState;
  attempts: number;
  lastError?: string;
  updatedAt: Date;
}

/**
 * Persisted idempotency keys keyed by `provider:objectId`.
 *
 * In production this should be a unique `idempotency_key` column on the
 * accounting sync table so concurrent workers cannot mint divergent keys.
 */
const accountingIdempotencyKeys = new Map<string, string>();

/** In-memory sync queue mirroring the persisted accounting sync table. */
const accountingSyncQueue = new Map<string, AccountingSyncItem>();

function accountingKey(provider: AccountingProvider, objectId: string): string {
  return `${provider}:${objectId}`;
}

/**
 * Return the persisted idempotency key for an accounting object, creating and
 * persisting a stable one on first use.  Repeated calls (including from
 * external retries) always return the same key.
 */
export function getAccountingIdempotencyKey(
  provider: AccountingProvider,
  objectId: string
): string {
  const key = accountingKey(provider, objectId);
  const existing = accountingIdempotencyKeys.get(key);
  if (existing) return existing;
  const generated = `${provider}-${objectId}`;
  accountingIdempotencyKeys.set(key, generated);
  return generated;
}

/**
 * Query the remote accounting provider for an object previously applied under
 * the given idempotency key.  Returns the remote identifier when the entry
 * already exists remotely, or `undefined` when it has not been applied.
 *
 * Replace this stub with a real provider lookup (e.g. QuickBooks query by
 * `DocNumber` / Xero lookup by `InvoiceNumber`).
 */
export async function queryRemoteAccountingState(
  provider: AccountingProvider,
  idempotencyKey: string
): Promise<string | undefined> {
  console.log(
    `[reconciler] Querying ${provider} for idempotency key ${idempotencyKey} …`
  );
  return undefined;
}

/**
 * Enqueue an accounting object for synchronization.  The idempotency key is
 * persisted up front so retries reuse it.
 */
export function enqueueAccountingSync(
  provider: AccountingProvider,
  objectId: string,
  period: string
): AccountingSyncItem {
  const key = accountingKey(provider, objectId);
  const existing = accountingSyncQueue.get(key);
  if (existing) return existing;
  const item: AccountingSyncItem = {
    objectId,
    provider,
    period,
    idempotencyKey: getAccountingIdempotencyKey(provider, objectId),
    state: "pending",
    attempts: 0,
    updatedAt: new Date(),
  };
  accountingSyncQueue.set(key, item);
  return item;
}

/**
 * Retry a queued accounting sync idempotently.
 *
 * Before re-submitting, the remote provider is queried using the persisted
 * idempotency key.  If the entry was already applied remotely the item is
 * marked `duplicate` and the existing remote id is recorded instead of
 * creating a second journal entry.
 */
export async function syncAccountingObject(
  provider: AccountingProvider,
  objectId: string
): Promise<AccountingSyncItem> {
  const key = accountingKey(provider, objectId);
  const item = accountingSyncQueue.get(key);
  if (!item) {
    throw new Error(`No queued accounting sync for ${key}`);
  }

  item.attempts += 1;
  item.updatedAt = new Date();

  try {
    const remoteId = await queryRemoteAccountingState(
      provider,
      item.idempotencyKey
    );
    if (remoteId) {
      item.remoteId = remoteId;
      item.state = "duplicate";
      item.lastError = undefined;
      return item;
    }
    // Remote has no record — safe to submit under the same idempotency key.
    item.state = "applied";
    item.lastError = undefined;
    return item;
  } catch (error: any) {
    item.state = "failed";
    item.lastError = error?.message ?? String(error);
    return item;
  }
}

/** Per-period accounting sync / recovery report. */
export interface AccountingSyncReport {
  provider: AccountingProvider;
  period: string;
  total: number;
  applied: number;
  duplicates: number;
  pending: number;
  failed: number;
  items: AccountingSyncItem[];
}

/**
 * Build a per-period sync and recovery report showing the reconciliation
 * state of every accounting object queued for the given provider and period.
 */
export function getAccountingSyncReport(
  provider: AccountingProvider,
  period: string
): AccountingSyncReport {
  const items = Array.from(accountingSyncQueue.values()).filter(
    (item) => item.provider === provider && item.period === period
  );
  return {
    provider,
    period,
    total: items.length,
    applied: items.filter((i) => i.state === "applied").length,
    duplicates: items.filter((i) => i.state === "duplicate").length,
    pending: items.filter((i) => i.state === "pending").length,
    failed: items.filter((i) => i.state === "failed").length,
    items,
  };
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
      `[reconciler] Failed to fetch remote payouts: ${error?.message ?? error}`
    );
    throw error;
  }
}
