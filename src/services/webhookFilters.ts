/**
 * Webhook subscription topic filters (Issue #119).
 *
 * Optional filters on a merchant webhook subscription. All specified fields
 * must match (AND). Empty / null filters mean "deliver all events of the
 * subscribed type" — preserving existing subscription behavior.
 */

export interface WebhookSubscriptionFilters {
  /** Deliver only when event amount >= this value */
  amount_min?: number;
  /** Exact currency code match (case-insensitive), e.g. "USD" */
  currency?: string;
  /** Exact provider match (case-insensitive), e.g. "mtn" */
  provider?: string;
  /** Exact transaction status match (case-insensitive), e.g. "completed" */
  status?: string;
}

const ALLOWED_FILTER_KEYS = new Set([
  "amount_min",
  "currency",
  "provider",
  "status",
]);

function readField(
  payload: Record<string, unknown>,
  ...keys: string[]
): unknown {
  for (const key of keys) {
    if (payload[key] !== undefined && payload[key] !== null) {
      return payload[key];
    }
  }
  // Nested data envelope used by some webhook payload shapes
  const data = payload.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const nested = data as Record<string, unknown>;
    for (const key of keys) {
      if (nested[key] !== undefined && nested[key] !== null) {
        return nested[key];
      }
    }
  }
  return undefined;
}

function normalizeString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s.length > 0 ? s.toLowerCase() : undefined;
}

/**
 * Validate and normalize an optional filters object from an API request.
 * Returns null when filters are absent / empty.
 * Throws Error with a user-facing message on invalid input.
 */
export function parseWebhookFilters(
  raw: unknown,
): WebhookSubscriptionFilters | null {
  if (raw === undefined || raw === null) return null;

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("filters must be a JSON object");
  }

  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FILTER_KEYS.has(key)) {
      throw new Error(
        `Unknown filter key: "${key}". Allowed: amount_min, currency, provider, status`,
      );
    }
  }

  const filters: WebhookSubscriptionFilters = {};

  if (input.amount_min !== undefined && input.amount_min !== null) {
    const n = Number(input.amount_min);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error("filters.amount_min must be a non-negative number");
    }
    filters.amount_min = n;
  }

  if (input.currency !== undefined && input.currency !== null) {
    if (typeof input.currency !== "string" || !input.currency.trim()) {
      throw new Error("filters.currency must be a non-empty string");
    }
    filters.currency = input.currency.trim();
  }

  if (input.provider !== undefined && input.provider !== null) {
    if (typeof input.provider !== "string" || !input.provider.trim()) {
      throw new Error("filters.provider must be a non-empty string");
    }
    filters.provider = input.provider.trim();
  }

  if (input.status !== undefined && input.status !== null) {
    if (typeof input.status !== "string" || !input.status.trim()) {
      throw new Error("filters.status must be a non-empty string");
    }
    filters.status = input.status.trim();
  }

  return Object.keys(filters).length > 0 ? filters : null;
}

/**
 * Returns true when the event payload should be delivered for this subscription.
 * AND semantics: every present filter key must match.
 * No filters → always true (backward compatible).
 */
export function matchesWebhookFilters(
  filters: WebhookSubscriptionFilters | null | undefined,
  payload: Record<string, unknown>,
): boolean {
  if (!filters) return true;
  const keys = Object.keys(filters) as Array<keyof WebhookSubscriptionFilters>;
  if (keys.length === 0) return true;

  if (filters.amount_min !== undefined) {
    const rawAmount = readField(payload, "amount");
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount) || amount < filters.amount_min) {
      return false;
    }
  }

  if (filters.currency !== undefined) {
    const currency = normalizeString(readField(payload, "currency"));
    if (currency !== normalizeString(filters.currency)) {
      return false;
    }
  }

  if (filters.provider !== undefined) {
    const provider = normalizeString(readField(payload, "provider"));
    if (provider !== normalizeString(filters.provider)) {
      return false;
    }
  }

  if (filters.status !== undefined) {
    const status = normalizeString(readField(payload, "status"));
    if (status !== normalizeString(filters.status)) {
      return false;
    }
  }

  return true;
}
