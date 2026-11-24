/**
 * Strict decoding for transaction pagination cursors.
 *
 * Cursors are opaque base64/base64url strings that wrap the keyset boundary
 * `(created_at, id)` of the `transactions` table. Two payload shapes exist:
 *
 *   - current: `{"v":1,"t":"<iso-8601>","id":"<uuid>"}` (written by
 *     `createPaginatedResponse`)
 *   - legacy:  `<iso-8601>|<uuid>`
 *
 * Anything else — wrong version, extra/missing fields, a non-UUID id, a
 * timestamp outside the supported window, or a value that is not even valid
 * base64 — is rejected with a `TransactionCursorError` so handlers can answer
 * `400` instead of letting structurally unexpected cursors reach SQL.
 */

import { z } from "zod";

export interface DecodedTransactionCursor {
  createdAt: Date;
  id: string;
}

/**
 * `transactions.id` is a `UUID` column (see `database/schema.sql`), so a
 * cursor id that is not UUID-shaped cannot name a row of this table.
 *
 * Deliberately a plain shape check rather than `z.string().uuid()`: the
 * canonical schema only constrains the 8-4-4-4-12 grouping, and fixtures may
 * use zeroed version/variant nibbles.
 */
const CURSOR_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Encoded cursors are base64 or base64url — nothing else may reach Buffer. */
const CURSOR_ENCODING_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * Cursors must resolve to a timestamp inside this window. Anything outside it
 * is structurally impossible for this service and is rejected up front.
 */
const CURSOR_MIN_TIMESTAMP = Date.UTC(2000, 0, 1);
const CURSOR_MAX_TIMESTAMP = Date.UTC(2100, 0, 1);

const cursorTimestampSchema = z
  .string()
  .datetime({ message: "cursor timestamp must be an ISO 8601 UTC timestamp" })
  .refine(
    (value) => {
      const time = Date.parse(value);
      return time >= CURSOR_MIN_TIMESTAMP && time <= CURSOR_MAX_TIMESTAMP;
    },
    { message: "cursor timestamp is outside the supported range" },
  );

const cursorIdSchema = z
  .string()
  .regex(CURSOR_ID_PATTERN, { message: "cursor id must be a UUID" });

/** Current payload: exact `{ v, t, id }` shape, version pinned to `1`. */
const versionedCursorSchema = z
  .object({
    v: z.literal(1),
    t: cursorTimestampSchema,
    id: cursorIdSchema,
  })
  .strict();

/** Thrown for every cursor that fails structural validation. */
export class TransactionCursorError extends Error {
  constructor(message = "Invalid transaction cursor") {
    super(message);
    this.name = "TransactionCursorError";
  }
}

function parseCursorPayload(decoded: string): {
  t: string;
  id: string;
} {
  let json: unknown;
  let isJson = false;
  try {
    json = JSON.parse(decoded);
    isJson = true;
  } catch {
    isJson = false;
  }

  // Valid JSON must match the versioned payload exactly — a wrong `v`,
  // an unexpected key, or a bad `t`/`id` is rejected rather than falling
  // through to the legacy format.
  if (isJson) {
    const versioned = versionedCursorSchema.safeParse(json);
    if (!versioned.success) {
      throw new TransactionCursorError();
    }
    return versioned.data;
  }

  // Legacy format: exactly one `<iso-timestamp>|<uuid>` pair.
  const parts = decoded.split("|");
  if (parts.length === 2) {
    const [t, id] = parts;
    const timestamp = cursorTimestampSchema.safeParse(t);
    const identifier = cursorIdSchema.safeParse(id);
    if (timestamp.success && identifier.success) {
      return { t: timestamp.data, id: identifier.data };
    }
  }

  throw new TransactionCursorError();
}

/**
 * Decode an opaque transaction cursor into its keyset boundary.
 *
 * @throws {TransactionCursorError} when the cursor is not base64, does not
 *   decode to a known payload shape, carries an unknown version, a non-UUID
 *   id, or a timestamp outside the supported range.
 */
export function decodeTransactionCursor(
  cursor: string,
): DecodedTransactionCursor {
  if (typeof cursor !== "string" || !CURSOR_ENCODING_PATTERN.test(cursor)) {
    throw new TransactionCursorError();
  }

  const decoded = Buffer.from(
    cursor.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  ).toString("utf8");

  const payload = parseCursorPayload(decoded);

  return { createdAt: new Date(payload.t), id: payload.id };
}
