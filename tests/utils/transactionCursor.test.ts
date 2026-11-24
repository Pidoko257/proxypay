/**
 * Unit and property tests for strict transaction cursor decoding.
 *
 * The decoder must accept exactly two payload shapes — the versioned
 * `{ v: 1, t, id }` object and the legacy `<iso-timestamp>|<uuid>` string —
 * and reject everything else: unknown versions, structurally unexpected
 * objects, non-UUID ids, timestamps outside the supported window and values
 * that are not even valid base64.
 */

import fc from "fast-check";
import { createCursor, encodeCursor } from "../../src/utils/pagination";
import {
  decodeTransactionCursor,
  TransactionCursorError,
} from "../../src/utils/transactionCursor";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIN_TIMESTAMP = new Date("2000-01-01T00:00:00.000Z");
const MAX_TIMESTAMP = new Date("2099-12-31T23:59:59.999Z");

const timestampArb = fc
  .date({ min: MIN_TIMESTAMP, max: MAX_TIMESTAMP, noInvalidDate: true })
  .map((value) => value.toISOString());

const uuidArb = fc.uuid();

const outOfRangeTimestampArb = fc
  .oneof(
    fc.date({ max: new Date("1999-12-31T23:59:59.999Z"), noInvalidDate: true }),
    fc.date({
      min: new Date("2100-01-01T00:00:01.000Z"),
      noInvalidDate: true,
    }),
  )
  .map((value) => value.toISOString());

const nonUuidArb = fc
  .string({ minLength: 1, maxLength: 64 })
  .filter((value) => !UUID_PATTERN.test(value));

const base64 = (value: string): string =>
  Buffer.from(value, "utf8").toString("base64");

const versionedCursor = (payload: unknown): string =>
  base64(JSON.stringify(payload));

const legacyCursor = (timestamp: string, id: string): string =>
  base64(`${timestamp}|${id}`);

describe("decodeTransactionCursor — accepted formats", () => {
  it("decodes the versioned `{ v, t, id }` payload", () => {
    const cursor = encodeCursor({
      v: 1,
      t: "2026-05-02T00:00:00.000Z",
      id: "00000000-0000-0000-0000-000000000002",
    });

    expect(decodeTransactionCursor(cursor)).toEqual({
      createdAt: new Date("2026-05-02T00:00:00.000Z"),
      id: "00000000-0000-0000-0000-000000000002",
    });
  });

  it("decodes the legacy `<timestamp>|<id>` payload", () => {
    const cursor = legacyCursor(
      "2026-05-02T00:00:00.000Z",
      "00000000-0000-0000-0000-000000000002",
    );

    expect(decodeTransactionCursor(cursor)).toEqual({
      createdAt: new Date("2026-05-02T00:00:00.000Z"),
      id: "00000000-0000-0000-0000-000000000002",
    });
  });

  it("decodes the base64url cursors emitted by createCursor", () => {
    const cursor = createCursor(
      new Date("2026-03-27T11:46:00.000Z"),
      "9f0d1f8e-1f6f-4e3a-9c1e-6b7b1a5f9c31",
    );

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeTransactionCursor(cursor)).toEqual({
      createdAt: new Date("2026-03-27T11:46:00.000Z"),
      id: "9f0d1f8e-1f6f-4e3a-9c1e-6b7b1a5f9c31",
    });
  });

  it("round-trips arbitrary valid versioned cursors", () => {
    fc.assert(
      fc.property(timestampArb, uuidArb, (t, id) => {
        const cursor = encodeCursor({ v: 1, t, id });
        expect(decodeTransactionCursor(cursor)).toEqual({
          createdAt: new Date(t),
          id,
        });
      }),
    );
  });

  it("round-trips arbitrary valid legacy cursors", () => {
    fc.assert(
      fc.property(timestampArb, uuidArb, (t, id) => {
        expect(decodeTransactionCursor(legacyCursor(t, id))).toEqual({
          createdAt: new Date(t),
          id,
        });
      }),
    );
  });
});

describe("decodeTransactionCursor — rejected formats", () => {
  it.each([
    ["an empty string", ""],
    ["a value that is not base64", "not-base64!"],
    ["base64 of unrelated text", base64("garbage")],
    ["base64 of a bare timestamp", base64("2026-05-02T00:00:00.000Z")],
    [
      "a legacy payload with multiple separators",
      legacyCursor(
        "2026-05-02T00:00:00.000Z",
        "00000000-0000-0000-0000-000000000002|extra",
      ),
    ],
    [
      "a legacy payload with a non-ISO timestamp",
      base64("2026-05-02 00:00:00|00000000-0000-0000-0000-000000000002"),
    ],
    [
      "a legacy payload with a non-UUID id",
      base64("2026-05-02T00:00:00.000Z|tx-5000"),
    ],
    [
      "a legacy payload dated outside the supported range",
      base64("1970-01-01T00:00:00.000Z|00000000-0000-0000-0000-000000000002"),
    ],
    [
      "a versioned payload with an unknown version",
      versionedCursor({
        v: 2,
        t: "2026-05-02T00:00:00.000Z",
        id: "00000000-0000-0000-0000-000000000002",
      }),
    ],
    [
      "a versioned payload with a non-UUID id",
      versionedCursor({ v: 1, t: "2026-05-02T00:00:00.000Z", id: "tx-5000" }),
    ],
    [
      "a versioned payload with an unexpected extra field",
      versionedCursor({
        v: 1,
        t: "2026-05-02T00:00:00.000Z",
        id: "00000000-0000-0000-0000-000000000002",
        extra: "unexpected",
      }),
    ],
    [
      "a versioned payload missing its id",
      versionedCursor({ v: 1, t: "2026-05-02T00:00:00.000Z" }),
    ],
    [
      "a versioned payload with a non-UTC timestamp",
      versionedCursor({
        v: 1,
        t: "2026-05-02T00:00:00+02:00",
        id: "00000000-0000-0000-0000-000000000002",
      }),
    ],
    [
      "a versioned payload dated outside the supported range",
      versionedCursor({
        v: 1,
        t: "2100-01-01T00:00:01.000Z",
        id: "00000000-0000-0000-0000-000000000002",
      }),
    ],
  ])("rejects %s", (_label, cursor) => {
    expect(() => decodeTransactionCursor(cursor)).toThrow(TransactionCursorError);
  });

  it("rejects arbitrary strings that are not base64 cursors", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (cursor) => {
        expect(() => decodeTransactionCursor(cursor)).toThrow(
          TransactionCursorError,
        );
      }),
    );
  });

  it("rejects any version other than 1", () => {
    fc.assert(
      fc.property(
        timestampArb,
        uuidArb,
        fc.integer({ min: 0, max: 50 }).filter((version) => version !== 1),
        (t, id, version) => {
          expect(() =>
            decodeTransactionCursor(versionedCursor({ v: version, t, id })),
          ).toThrow(TransactionCursorError);
        },
      ),
    );
  });

  it("rejects structurally unexpected versioned payloads", () => {
    fc.assert(
      fc.property(timestampArb, uuidArb, fc.string(), (t, id, extra) => {
        expect(() =>
          decodeTransactionCursor(versionedCursor({ v: 1, t, id, extra })),
        ).toThrow(TransactionCursorError);
        expect(() =>
          decodeTransactionCursor(versionedCursor({ v: 1, t })),
        ).toThrow(TransactionCursorError);
      }),
    );
  });

  it("rejects non-UUID ids in both payload shapes", () => {
    fc.assert(
      fc.property(timestampArb, nonUuidArb, (t, id) => {
        expect(() =>
          decodeTransactionCursor(versionedCursor({ v: 1, t, id })),
        ).toThrow(TransactionCursorError);
        expect(() => decodeTransactionCursor(legacyCursor(t, id))).toThrow(
          TransactionCursorError,
        );
      }),
    );
  });

  it("rejects timestamps outside the supported range in both payload shapes", () => {
    fc.assert(
      fc.property(outOfRangeTimestampArb, uuidArb, (t, id) => {
        expect(() =>
          decodeTransactionCursor(versionedCursor({ v: 1, t, id })),
        ).toThrow(TransactionCursorError);
        expect(() => decodeTransactionCursor(legacyCursor(t, id))).toThrow(
          TransactionCursorError,
        );
      }),
    );
  });
});
