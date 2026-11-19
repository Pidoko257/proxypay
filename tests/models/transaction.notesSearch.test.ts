/**
 * Notes are encrypted at rest, so notes search must go through keyed word
 * digests (notes_search_tokens) rather than to_tsvector() over ciphertext.
 */

const mockQueryWrite = jest.fn();
const mockQueryRead = jest.fn();

jest.mock("../../src/config/database", () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
  queryRead: (...args: unknown[]) => mockQueryRead(...args),
  queryWrite: (...args: unknown[]) => mockQueryWrite(...args),
}));

jest.mock("../../src/utils/encryption", () => ({
  encrypt: (value: unknown) => (value == null ? value : `enc(${value})`),
  decrypt: (value: unknown) =>
    typeof value === "string" ? value.replace(/^enc\((.*)\)$/s, "$1") : value,
  hashSearchValue: (value: string) => `hash:${value}`,
}));

jest.mock("../../src/services/transactionStatusWorkflowService", () => ({
  transactionStatusWorkflowService: { validateBaseTransition: jest.fn() },
}));

jest.mock("../../src/services/cachedTransactionService", () => ({
  CachedTransactionInvalidation: {
    invalidateUserCaches: jest.fn(async () => undefined),
    invalidateProviderStats: jest.fn(async () => undefined),
    invalidateGeneralStats: jest.fn(async () => undefined),
  },
}));

jest.mock("../../src/graphql/redisPubSub", () => ({
  getRedisPubSub: jest.fn(() => ({ publish: jest.fn() })),
}));

jest.mock("../../src/websocket", () => ({
  WebSocketManager: { getInstance: jest.fn(() => null) },
}));

import {
  InvalidNotesSearchQueryError,
  TransactionModel,
  notesSearchTokens,
  tokenizeNotes,
} from "../../src/models/transaction";

describe("notes search tokens", () => {
  it("normalizes case, punctuation and duplicates", () => {
    expect(tokenizeNotes("Refund, REFUND! customer-called x")).toEqual([
      "refund",
      "customer",
      "called",
    ]);
  });

  it("handles non-ASCII words", () => {
    expect(tokenizeNotes("Remboursement Évalué")).toEqual([
      "remboursement",
      "évalué",
    ]);
  });

  it("hashes words with a notes-specific prefix", () => {
    expect(notesSearchTokens("Refund pending")).toEqual([
      "hash:notes:refund",
      "hash:notes:pending",
    ]);
  });

  it("returns no tokens for empty notes", () => {
    expect(notesSearchTokens(null)).toEqual([]);
    expect(notesSearchTokens("")).toEqual([]);
  });
});

describe("TransactionModel notes search", () => {
  const model = new TransactionModel();

  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryRead.mockResolvedValue({ rows: [] });
    mockQueryWrite.mockResolvedValue({ rows: [{}], rowCount: 1 });
  });

  it("searches the token columns instead of to_tsvector over ciphertext", async () => {
    await model.searchByNotes("Customer refund");

    const [sql, params] = mockQueryRead.mock.calls[0];
    expect(sql).not.toMatch(/to_tsvector/);
    expect(sql).toMatch(/notes_search_tokens @> \$1::text\[\]/);
    expect(sql).toMatch(/admin_notes_search_tokens @> \$1::text\[\]/);
    expect(params).toEqual([["hash:notes:customer", "hash:notes:refund"]]);
  });

  it("rejects queries with no searchable words instead of silently returning nothing", async () => {
    await expect(model.searchByNotes("  !! ")).rejects.toBeInstanceOf(
      InvalidNotesSearchQueryError,
    );
    expect(mockQueryRead).not.toHaveBeenCalled();
  });

  it("stores tokens computed from plaintext when notes are updated", async () => {
    await model.updateNotes("tx-1", "Customer refund");

    const [sql, params] = mockQueryWrite.mock.calls[0];
    expect(sql).toMatch(/notes_search_tokens = \$2/);
    expect(params).toEqual([
      "enc(Customer refund)",
      ["hash:notes:customer", "hash:notes:refund"],
      "tx-1",
    ]);
  });

  it("stores tokens computed from plaintext when admin notes are updated", async () => {
    await model.updateAdminNotes("tx-1", "Escalated");

    const [sql, params] = mockQueryWrite.mock.calls[0];
    expect(sql).toMatch(/admin_notes_search_tokens = \$2/);
    expect(params[1]).toEqual(["hash:notes:escalated"]);
  });

  it("backfills tokens from decrypted notes", async () => {
    mockQueryWrite
      .mockResolvedValueOnce({
        rows: [{ id: "tx-1", notes: "enc(Late fee)", admin_notes: null }],
      })
      .mockResolvedValue({ rows: [], rowCount: 1 });

    const result = await model.backfillNotesSearchTokens(10);

    expect(result).toEqual({ processed: 1, lastId: "tx-1" });
    const [, params] = mockQueryWrite.mock.calls[1];
    expect(params).toEqual([
      ["hash:notes:late", "hash:notes:fee"],
      [],
      "tx-1",
    ]);
  });
});
