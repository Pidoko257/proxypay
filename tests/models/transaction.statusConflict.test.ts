/**
 * updateStatus with a caller-supplied currentStatus must be a compare-and-set:
 * two concurrent workers must not both "win" (last-writer-wins).
 */

const mockQueryWrite = jest.fn();
const mockValidateBaseTransition = jest.fn();

jest.mock("../../src/config/database", () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
  queryRead: jest.fn(),
  queryWrite: (...args: unknown[]) => mockQueryWrite(...args),
}));

jest.mock("../../src/utils/encryption", () => ({
  encrypt: (value: unknown) => value,
  decrypt: (value: unknown) => value,
  hashSearchValue: (value: string) => `hash:${value}`,
}));

jest.mock("../../src/services/transactionStatusWorkflowService", () => ({
  transactionStatusWorkflowService: {
    validateBaseTransition: (...args: unknown[]) =>
      mockValidateBaseTransition(...args),
  },
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
  TransactionModel,
  TransactionStatus,
  TransactionStatusConflictError,
} from "../../src/models/transaction";

const updatedRow = {
  user_id: "user-1",
  provider: "mtn",
  reference_number: "TX-1",
  type: "deposit",
  updated_at: new Date().toISOString(),
};

describe("TransactionModel.updateStatus compare-and-set", () => {
  const model = new TransactionModel();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("guards the UPDATE on the expected current status", async () => {
    mockQueryWrite.mockResolvedValue({ rowCount: 1, rows: [updatedRow] });

    await model.updateStatus(
      "tx-1",
      TransactionStatus.Review,
      undefined,
      TransactionStatus.Pending,
    );

    const [sql, params] = mockQueryWrite.mock.calls[0];
    expect(sql).toMatch(/WHERE id=\$2 AND status=\$3/);
    expect(params).toEqual([
      TransactionStatus.Review,
      "tx-1",
      TransactionStatus.Pending,
    ]);
    expect(mockValidateBaseTransition).toHaveBeenCalledWith(
      "tx-1",
      TransactionStatus.Pending,
      TransactionStatus.Review,
    );
  });

  it("numbers parameters correctly when both userId and currentStatus are given", async () => {
    mockQueryWrite.mockResolvedValue({ rowCount: 1, rows: [updatedRow] });

    await model.updateStatus(
      "tx-1",
      TransactionStatus.Review,
      "user-1",
      TransactionStatus.Pending,
    );

    const [sql, params] = mockQueryWrite.mock.calls[0];
    expect(sql).toMatch(/WHERE id=\$2 AND user_id=\$3 AND status=\$4/);
    expect(params).toEqual([
      TransactionStatus.Review,
      "tx-1",
      "user-1",
      TransactionStatus.Pending,
    ]);
  });

  it("throws a conflict when another worker already changed the status", async () => {
    mockQueryWrite
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // guarded UPDATE
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ status: TransactionStatus.Failed }],
      }); // existence check

    const attempt = model.updateStatus(
      "tx-1",
      TransactionStatus.Review,
      undefined,
      TransactionStatus.Pending,
    );

    await expect(attempt).rejects.toBeInstanceOf(TransactionStatusConflictError);
    await expect(attempt).rejects.toMatchObject({
      expectedStatus: TransactionStatus.Pending,
      actualStatus: TransactionStatus.Failed,
      requestedStatus: TransactionStatus.Review,
    });
  });

  it("returns undefined (not a conflict) when the transaction does not exist", async () => {
    mockQueryWrite
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(
      model.updateStatus(
        "missing",
        TransactionStatus.Review,
        undefined,
        TransactionStatus.Pending,
      ),
    ).resolves.toBeUndefined();
  });

  it("keeps the unguarded behaviour when no currentStatus is supplied", async () => {
    mockQueryWrite.mockResolvedValue({ rowCount: 1, rows: [updatedRow] });

    await model.updateStatus("tx-1", TransactionStatus.Review);

    const [sql, params] = mockQueryWrite.mock.calls[0];
    expect(sql).not.toMatch(/AND status=/);
    expect(params).toEqual([TransactionStatus.Review, "tx-1"]);
    expect(mockValidateBaseTransition).not.toHaveBeenCalled();
  });
});
