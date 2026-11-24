/**
 * Tests for #645 – Transaction Metadata Schema Validation
 *
 * Validates that:
 *  - metadataSchema accepts valid well-formed metadata
 *  - validateMetadataSchema() throws for invalid field types/lengths
 *  - Unknown extra keys (top-level and nested) are passed through and retained
 *    (forward-compatible via .passthrough())
 *  - validateMetadata() enforces the serialized size cap
 */

import { describe, it, expect } from "@jest/globals";
import {
  metadataSchema,
  validateMetadataSchema,
  validateMetadata,
  MAX_METADATA_BYTES,
} from "../transaction";

// ── Schema unit tests ─────────────────────────────────────────────────────────

describe("metadataSchema (#645)", () => {
  it("accepts an empty object", () => {
    expect(metadataSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a fully-populated valid metadata object", () => {
    const result = metadataSchema.safeParse({
      note: "Test payment",
      orderId: "ORD-001",
      customerRef: "CUST-XYZ",
      sourceCurrency: "XAF",
      destinationCurrency: "USD",
      senderName: "Jean Dupont",
      senderAddress: "123 Rue de la Paix, Douala",
      senderDob: "1990-01-15",
      senderIdNumber: "CM-ID-123456",
      receiverName: "Jane Smith",
      receiverAddress: "456 Main St, Nairobi",
      tags: ["priority", "vip"],
      stellar: {
        transactionHash: "abc123",
        submittedAt: new Date().toISOString(),
        feeBumps: [],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a note that exceeds 500 characters", () => {
    expect(metadataSchema.safeParse({ note: "x".repeat(501) }).success).toBe(false);
  });

  it("rejects an orderId longer than 128 characters", () => {
    expect(metadataSchema.safeParse({ orderId: "o".repeat(129) }).success).toBe(false);
  });

  it("rejects a sourceCurrency that is not exactly 3 characters", () => {
    expect(metadataSchema.safeParse({ sourceCurrency: "XA" }).success).toBe(false);
    expect(metadataSchema.safeParse({ sourceCurrency: "XAFF" }).success).toBe(false);
    expect(metadataSchema.safeParse({ sourceCurrency: "XAF" }).success).toBe(true);
  });

  it("rejects tags array with more than 10 items", () => {
    expect(
      metadataSchema.safeParse({ tags: ["a","b","c","d","e","f","g","h","i","j","k"] }).success,
    ).toBe(false);
  });

  it("rejects individual tag strings longer than 64 characters", () => {
    expect(metadataSchema.safeParse({ tags: ["t".repeat(65)] }).success).toBe(false);
  });

  it("allows unknown top-level keys (passthrough for forward compatibility)", () => {
    const result = metadataSchema.safeParse({
      note: "ok",
      customProviderField: "some value",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as any).customProviderField).toBe("some value");
    }
  });

  it("allows partial metadata – only the provided fields are checked", () => {
    expect(metadataSchema.safeParse({ senderName: "Alice" }).success).toBe(true);
  });
});

// ── validateMetadataSchema helper tests ───────────────────────────────────────

describe("validateMetadataSchema (#645)", () => {
  it("returns the validated object for valid metadata", () => {
    const input = { note: "Hello", orderId: "ORD-42" };
    const result = validateMetadataSchema(input);
    expect(result.note).toBe("Hello");
    expect(result.orderId).toBe("ORD-42");
  });

  it("throws an Error with a human-readable message for invalid metadata", () => {
    expect(() =>
      validateMetadataSchema({ note: "x".repeat(501) }),
    ).toThrow(/Invalid metadata/i);
  });

  it("includes the failing field path in the error message", () => {
    let message = "";
    try {
      validateMetadataSchema({ sourceCurrency: "TOOLONG" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/sourceCurrency/i);
  });

  it("works with valid reconciliation sub-object (arbitrary keys allowed)", () => {
    expect(() =>
      validateMetadataSchema({
        reconciliation: { auto_corrected: true, corrected_at: "2024-01-01" },
      }),
    ).not.toThrow();
  });

  it("rejects an array at the top level", () => {
    // metadataSchema.safeParse([]) would fail since it expects an object
    expect(() => validateMetadataSchema([{ note: "bad" }])).toThrow();
  });
});

// ── Unknown / nested key handling (#645) ──────────────────────────────────────

describe("metadata unknown & nested keys (#645)", () => {
  it("retains unknown top-level keys through validateMetadataSchema", () => {
    const result = validateMetadataSchema({
      note: "ok",
      customProviderField: "some value",
    });
    expect(result.customProviderField).toBe("some value");
  });

  it("retains unknown keys nested inside the stellar sub-object (passthrough)", () => {
    const result = metadataSchema.safeParse({
      stellar: {
        transactionHash: "abc123",
        providerDiagnostic: { attempt: 3, detail: "boom" },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data.stellar as any).providerDiagnostic).toEqual({
        attempt: 3,
        detail: "boom",
      });
    }
  });

  it("retains arbitrary keys nested inside reconciliation", () => {
    const result = metadataSchema.safeParse({
      reconciliation: { auto_corrected: true, corrected_at: "2024-01-01" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data.reconciliation as any).auto_corrected).toBe(true);
    }
  });

  it("retains deep structures under an unknown top-level key", () => {
    const result = validateMetadataSchema({
      xProvider: { nested: { deep: [1, 2, 3] } },
    });
    expect(result.xProvider).toEqual({ nested: { deep: [1, 2, 3] } });
  });

  it("still validates known fields while retaining siblings", () => {
    expect(() =>
      validateMetadataSchema({ note: "x".repeat(501), extra: "kept" }),
    ).toThrow(/note/i);
  });
});

// ── Serialized size limit (#645) ──────────────────────────────────────────────

describe("validateMetadata size limit (#645)", () => {
  it("accepts metadata at the byte cap", () => {
    // JSON.stringify({ blob }) adds 11 bytes of structural overhead, so this
    // serializes to exactly MAX_METADATA_BYTES.
    const blob = "x".repeat(MAX_METADATA_BYTES - 11);
    expect(Buffer.byteLength(JSON.stringify({ blob }), "utf8")).toBe(
      MAX_METADATA_BYTES,
    );
    expect(() => validateMetadata({ blob })).not.toThrow();
  });

  it("rejects metadata exceeding the byte cap", () => {
    const blob = "x".repeat(MAX_METADATA_BYTES);
    expect(() => validateMetadata({ blob })).toThrow(/exceeds/i);
  });

  it("returns an empty object for nullish metadata", () => {
    expect(validateMetadata(undefined)).toEqual({});
    expect(validateMetadata(null)).toEqual({});
  });

  it("rejects an array at the top level", () => {
    expect(() => validateMetadata([{ note: "bad" }])).toThrow(
      /JSON object/i,
    );
  });
});
