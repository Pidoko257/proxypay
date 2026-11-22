/**
 * UserModel.updateStatus must read the old status on the write client, inside
 * the transaction, with FOR UPDATE, so concurrent callers can't both audit
 * the same (stale) old_status.
 */
import { describe, expect, it, beforeEach, jest } from "@jest/globals";

const mockClientQuery = jest.fn<(...args: any[]) => Promise<any>>();
const mockRelease = jest.fn();
const mockQueryRead = jest.fn<(...args: any[]) => Promise<any>>();

jest.mock("../../src/config/database", () => ({
  queryRead: (...args: any[]) => mockQueryRead(...args),
  queryWrite: jest.fn(),
  pool: {
    connect: jest.fn(async () => ({
      query: mockClientQuery,
      release: mockRelease,
    })),
  },
}));

jest.mock("../../src/utils/encryption", () => ({
  encrypt: (v: unknown) => v,
  decrypt: (v: unknown) => v,
  encryptField: (v: unknown) => v,
  decryptField: (v: unknown) => v,
}));

import { UserModel, UserStatus } from "../../src/models/users";

const updatedRow = {
  id: "user-1",
  phone_number: "+237600000000",
  kyc_level: "basic",
  email: null,
  two_factor_secret: null,
  status: UserStatus.FROZEN,
  created_at: new Date(),
  updated_at: new Date(),
};

const sqlCalls = () => mockClientQuery.mock.calls.map(([sql]) => String(sql));

describe("UserModel.updateStatus", () => {
  const model = new UserModel();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("locks and reads the current status inside the write transaction", async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FOR UPDATE")) {
        return { rows: [{ status: UserStatus.ACTIVE }] };
      }
      if (sql.startsWith("UPDATE users")) return { rows: [updatedRow] };
      return { rows: [] };
    });

    await model.updateStatus("user-1", UserStatus.FROZEN, "admin-1", "fraud");

    const calls = sqlCalls();
    const begin = calls.indexOf("BEGIN");
    const lock = calls.findIndex((sql) =>
      /SELECT status FROM users WHERE id = \$1 FOR UPDATE/.test(sql),
    );
    const update = calls.findIndex((sql) => sql.startsWith("UPDATE users"));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(begin);
    expect(update).toBeGreaterThan(lock);

    // The old status must not come from the read pool.
    expect(mockQueryRead).not.toHaveBeenCalled();
  });

  it("audits the old status read under the lock", async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FOR UPDATE")) {
        return { rows: [{ status: UserStatus.SUSPENDED }] };
      }
      if (sql.startsWith("UPDATE users")) {
        return { rows: [{ ...updatedRow, status: UserStatus.ACTIVE }] };
      }
      return { rows: [] };
    });

    await model.updateStatus("user-1", UserStatus.ACTIVE, "admin-1");

    const audit = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO user_status_audit"),
    );
    expect(audit).toBeDefined();
    const params = audit![1] as unknown[];
    expect(params[1]).toBe("UNSUSPEND");
    expect(params[2]).toBe(UserStatus.SUSPENDED); // old_status
    expect(params[3]).toBe(UserStatus.ACTIVE); // new_status
    expect(sqlCalls()).toContain("COMMIT");
    expect(mockRelease).toHaveBeenCalled();
  });

  it("rolls back and returns null when the user does not exist", async () => {
    mockClientQuery.mockImplementation(async () => ({ rows: [] }));

    const result = await model.updateStatus(
      "missing",
      UserStatus.FROZEN,
      "admin-1",
    );

    expect(result).toBeNull();
    expect(sqlCalls()).toContain("ROLLBACK");
    expect(sqlCalls().some((sql) => sql.startsWith("UPDATE users"))).toBe(
      false,
    );
    expect(mockRelease).toHaveBeenCalled();
  });
});
