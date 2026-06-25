import { queryRead, queryWrite } from "../config/database";
import { redisClient } from "../config/redis";
import { ERROR_CODES } from "../constants/errorCodes";

const CACHE_KEY = "allowed_countries";
const CACHE_TTL = 300; // 5 minutes

export class UnsupportedCountryError extends Error {
  readonly code = ERROR_CODES.ERR_UNSUPPORTED_COUNTRY;
  readonly countryCode: string;

  constructor(countryCode: string) {
    super(`Country '${countryCode}' is not supported for payment processing`);
    this.countryCode = countryCode;
  }
}

/** Returns the set of currently-enabled ISO 3166-1 alpha-2 country codes. */
async function loadEnabledCountries(): Promise<Set<string>> {
  // 1. Try Redis cache
  try {
    const cached = await redisClient.get(CACHE_KEY);
    if (cached) return new Set(JSON.parse(cached) as string[]);
  } catch {
    // Cache miss / Redis down — fall through to DB
  }

  // 2. Load from DB
  const { rows } = await queryRead<{ code: string }>(
    "SELECT code FROM allowed_countries WHERE enabled = true",
  );
  const codes = rows.map((r) => r.code);

  // 3. Populate cache
  try {
    await redisClient.setEx(CACHE_KEY, CACHE_TTL, JSON.stringify(codes));
  } catch {
    // Non-fatal — continue without cache
  }

  return new Set(codes);
}

/** Invalidate the cached allowed-countries list. */
export async function invalidateCountryCache(): Promise<void> {
  try {
    await redisClient.del(CACHE_KEY);
  } catch {
    // Best-effort
  }
}

/**
 * Validates that every supplied country code is in the enabled allowed list.
 * Throws UnsupportedCountryError for the first unsupported code found.
 */
export async function validateCountries(...codes: string[]): Promise<void> {
  const enabled = await loadEnabledCountries();
  for (const code of codes) {
    if (!enabled.has(code.toUpperCase())) {
      throw new UnsupportedCountryError(code.toUpperCase());
    }
  }
}

/** Toggle a country's enabled status and invalidate the cache. */
export async function setCountryStatus(
  code: string,
  enabled: boolean,
): Promise<{ code: string; name: string; enabled: boolean } | null> {
  const { rows } = await queryWrite<{
    code: string;
    name: string;
    enabled: boolean;
  }>(
    `UPDATE allowed_countries
        SET enabled = $1, updated_at = now()
      WHERE code = $2
  RETURNING code, name, enabled`,
    [enabled, code.toUpperCase()],
  );

  if (rows.length === 0) return null;
  await invalidateCountryCache();
  return rows[0];
}
