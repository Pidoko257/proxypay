/**
 * Data classification for GDPR data exports (#649).
 *
 * A subject-access export is a full-fidelity copy of everything the platform
 * holds about a person, which is exactly what makes it valuable to an attacker
 * if the archive leaks. This module gives every exported field an explicit
 * classification so the export can be masked selectively instead of being
 * either fully raw or fully redacted:
 *
 *   - `public`      – safe to show in full (ids, statuses, timestamps, enums).
 *   - `internal`    – operational detail that reveals usage patterns but no
 *                     direct identifier (amounts, fees, provider names).
 *   - `confidential`– directly identifying data (phone, email, name, address,
 *                     Stellar address, uploaded file names).
 *   - `restricted`  – authentication material that must never leave the
 *                     platform in any export (2FA secrets, backup codes,
 *                     webhook secrets, idempotency keys).
 *
 * Masking is applied by classification, so adding a new column to a table does
 * not silently start leaking it: an unrecognised field is treated as
 * `confidential` and masked by default.
 */

import {
  maskEmail,
  maskPhoneNumber,
  maskStellarAddress,
} from "./masking";

export type DataClassification =
  | "public"
  | "internal"
  | "confidential"
  | "restricted";

/** Placeholder substituted for a masked value. */
/**
 * Explicit classification per field name. Keys are compared
 * case-insensitively with `_` and `-` removed, so a column can be classified
 * under either its SQL or its camelCase spelling.
 */
const FIELD_CLASSIFICATIONS: Record<string, DataClassification> = {
  // public – identifiers and state that identify nothing on their own
  id: "public",
  user_id: "public",
  transaction_id: "public",
  merchant_id: "public",
  reference_number: "public",
  provider_reference: "public",
  status: "public",
  type: "public",
  currency: "public",
  kyc_level: "public",
  kyc_status: "public",
  is_active: "public",
  two_factor_enabled: "public",
  two_factor_verified: "public",
  created_at: "public",
  updated_at: "public",
  deactivated_at: "public",
  expires_at: "public",
  last_used_at: "public",
  timestamp: "public",
  events: "public",
  tags: "public",
  scan_status: "public",
  size_bytes: "public",
  declared_mimetype: "public",

  // internal – commercially sensitive but not directly identifying
  amount: "internal",
  fee: "internal",
  fees: "internal",
  user_fees: "internal",
  provider_fees: "internal",
  pnl: "internal",
  balance: "internal",
  provider: "internal",
  original_filename: "internal",
  admin_notes: "internal",
  notes: "internal",
  metadata: "internal",
  location_metadata: "internal",
  resource: "internal",
  action: "internal",
  diff: "internal",
  ip_address: "internal",

  // confidential – directly identifying
  phone_number: "confidential",
  phone: "confidential",
  msisdn: "confidential",
  email: "confidential",
  display_name: "confidential",
  name: "confidential",
  first_name: "confidential",
  last_name: "confidential",
  full_name: "confidential",
  address: "confidential",
  id_number: "confidential",
  national_id: "confidential",
  passport_number: "confidential",
  date_of_birth: "confidential",
  stellar_address: "confidential",
  account_id: "confidential",
  url: "confidential",

  // restricted – must never leave the platform
  two_factor_secret: "restricted",
  backup_codes: "restricted",
  secret: "restricted",
  signing_secret: "restricted",
  webhook_secret: "restricted",
  api_key: "restricted",
  idempotency_key: "restricted",
  password_hash: "restricted",
  token: "restricted",
  refresh_token: "restricted",
  private_key: "restricted",
};

/** Normalises a field name for lookup in the classification table. */
function normaliseField(field: string): string {
  return field.toLowerCase().replace(/[-_\s]/g, "");
}

/**
 * Classifies a field. Unknown fields are treated as `confidential` so a newly
 * added column is masked rather than exported in the clear.
 */
export function classifyField(field: string): DataClassification {
  const key = normaliseField(field);
  for (const [name, classification] of Object.entries(FIELD_CLASSIFICATIONS)) {
    if (normaliseField(name) === key) return classification;
  }
  return "confidential";
}

/** True when a classification is masked unless the caller opts in. */
export function isMaskedByDefault(classification: DataClassification): boolean {
  return MASKED_BY_DEFAULT.has(classification);
}

export interface MaskingOptions {
  /**
   * Include `confidential` values in the clear. Off by default: an export is a
   * portable file, and a portable file leaks. `restricted` values are still
   * redacted regardless – authentication material never leaves the platform.
   */
  includeConfidential?: boolean;
  /**
   * Include `internal` values (amounts, fees, provider metadata). Off by
   * default so a masked export does not disclose a user's financial history.
   */
  includeInternal?: boolean;
}

export interface MaskedExport {
  /** The masked value tree. */
  data: unknown;
  /** Field paths whose value was replaced, with the reason. */
  maskedFields: Array<{ path: string; classification: DataClassification }>;
}

/**
 * Applies a classification-appropriate mask to a single scalar value.
 * Exported for reuse and for direct unit testing.
 */
export function maskValue(
  value: unknown,
  field: string,
  options: MaskingOptions = {},
): unknown {
  if (value == null) return value;

  const classification = classifyField(field);

  // Authentication material is redacted unconditionally: no option, and no
  // combination of options, can put a 2FA seed or a backup code in an export.
  if (classification === "restricted") return REDACTED;

  if (classification === "confidential" && !options.includeConfidential) {
    return maskWithShape(value, field);
  }
  if (classification === "internal" && !options.includeInternal) {
    return REDACTED;
  }
  return value;
}

/**
 * Partially masks a value where a recognisable but non-identifying form still
 * lets the data subject verify their own record.
 */

/**
 * Recursively masks a record (or array of records) according to the
 * classification of each field, and reports which fields were touched so the
 * export can ship a manifest of what was withheld.
 */
export function maskExportData(
  data: unknown,
  options: MaskingOptions = {},
  path = "",
): MaskedExport {
  const maskedFields: MaskedExport["maskedFields"] = [];

  const walk = (value: unknown, currentPath: string, fieldName: string): unknown => {
    if (value == null) return value;

    if (Array.isArray(value)) {
      return value.map((item, idx) =>
        walk(item, `${currentPath}[${idx}]`, fieldName),
      );
    }

    if (typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const childPath = currentPath ? `${currentPath}.${key}` : key;
        out[key] = walk(child, childPath, key);
      }
      return out;
    }

    const classification = classifyField(fieldName);
    const masked =
      classification === "restricted" ||
      (classification === "confidential" && !options.includeConfidential) ||
      (classification === "internal" && !options.includeInternal);

    if (masked) {
      maskedFields.push({ path: currentPath, classification });
      return REDACTED;
    }

    return value;
  };

  return { data: walk(data, path, ""), maskedFields };
}

function maskWithShape(value: unknown, field: string): unknown {
  if (typeof value !== "string") return REDACTED;
  const key = normaliseField(field);
  if (key === "phone" || key === "phonenumber" || key === "msisdn") {
    return maskPhoneNumber(value);
  }
  if (key === "email") return maskEmail(value);
  if (key === "stellaraddress" || key === "accountid") {
    return maskStellarAddress(value);
  }
  return REDACTED;
}

export const REDACTED = "[REDACTED]";

/** Classifications whose values are masked unless explicitly included. */
const MASKED_BY_DEFAULT: ReadonlySet<DataClassification> = new Set([
  "confidential",
  "restricted",
]);
