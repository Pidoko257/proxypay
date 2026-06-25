import { Pool } from "pg";
import * as StellarSdk from "stellar-sdk";
import { createAccountMergeMonitor } from "../accountMergeMonitor";
import { TransactionStatus } from "../../models/transaction";

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock("../../services/email", () => ({
  emailService: { sendEmail: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import { emailService } from "../../services/email";
const mockSendEmail = emailService.sendEmail as jest.Mock;

// Build a minimal mock Horizon server that captures the stream() handler
function makeMockServer() {
  let onmessage: ((op: any) => void) | undefined;
  let onerror: ((err: Error) => void) | undefined;
  const stopMock = jest.fn();

  const streamMock = jest.fn(({ onmessage: om, onerror: oe }) => {
    onmessage = om;
    onerror = oe;
    return stopMock;
  });

  const server = {
    operations: () => ({
      forAccount: () => ({
        cursor: () => ({ stream: streamMock }),
      }),
    }),
    _emit: (op: any) => onmessage?.(op),
    _error: (err: Error) => onerror?.(err),
    _streamMock: streamMock,
    _stopMock: stopMock,
  } as unknown as StellarSdk.Horizon.Server & {
    _emit(op: any): void;
    _error(err: Error): void;
    _streamMock: jest.Mock;
    _stopMock: jest.Mock;
  };

  return server;
}

function makeMockDb(activeAccounts: string[] = ["GABC...", "GDEF..."]) {
  const queryMock = jest.fn();

  // Default responses in call order:
  // 1st call: SELECT stellar_address (start)
  queryMock.mockResolvedValueOnce({
    rows: activeAccounts.map((a) => ({ stellar_address: a })),
    rowCount: activeAccounts.length,
  });

  return { query: queryMock } as unknown as Pool;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AccountMergeMonitor", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPS_ALERT_EMAIL = "ops@proxypay.io";
  });

  describe("start()", () => {
    it("streams operations for each active monitored account", async () => {
      const server = makeMockServer();
      const db = makeMockDb(["GAAA...", "GBBB..."]);
      const monitor = createAccountMergeMonitor(db, server);

      await monitor.start();

      // One stream per active account
      expect((server as any)._streamMock).toHaveBeenCalledTimes(2);
      monitor.stop();
    });

    it("does nothing when there are no active accounts", async () => {
      const server = makeMockServer();
      const db = makeMockDb([]);
      const monitor = createAccountMergeMonitor(db, server);

      await monitor.start();

      expect((server as any)._streamMock).not.toHaveBeenCalled();
    });
  });

  describe("account_merge detection", () => {
    async function setupAndTriggerMerge(mergedAccount = "GMERGED...") {
      const server = makeMockServer();
      const db = makeMockDb([mergedAccount]);

      // Responses for handleMerge queries (after the start query):
      // UPDATE transactions
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ id: "tx-1" }, { id: "tx-2" }], rowCount: 2 });
      // UPDATE users (freeze)
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [], rowCount: 1 });
      // INSERT merged_stellar_accounts
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const monitor = createAccountMergeMonitor(db, server);
      await monitor.start();

      // Simulate account_merge operation arriving on the stream
      (server as any)._emit({
        type: "account_merge",
        source_account: mergedAccount,
        into: "GDEST...",
      });

      // Let async handleMerge settle
      await new Promise((r) => setTimeout(r, 10));

      monitor.stop();
      return { db, server };
    }

    it("flags associated transactions to review status", async () => {
      const { db } = await setupAndTriggerMerge("GMERGED...");
      const calls = (db.query as jest.Mock).mock.calls;

      const updateTxCall = calls.find(
        ([sql]: [string]) => sql.includes("UPDATE transactions") && sql.includes("status"),
      );
      expect(updateTxCall).toBeDefined();
      expect(updateTxCall[1][0]).toBe(TransactionStatus.Review);
      expect(updateTxCall[1][1]).toBe("GMERGED...");
    });

    it("freezes the merged account in users table", async () => {
      const { db } = await setupAndTriggerMerge("GMERGED...");
      const calls = (db.query as jest.Mock).mock.calls;

      const freezeCall = calls.find(
        ([sql]: [string]) =>
          sql.includes("UPDATE users") && sql.includes("frozen"),
      );
      expect(freezeCall).toBeDefined();
      expect(freezeCall[1][0]).toBe("GMERGED...");
    });

    it("records the merged account to prevent future use", async () => {
      const { db } = await setupAndTriggerMerge("GMERGED...");
      const calls = (db.query as jest.Mock).mock.calls;

      const insertCall = calls.find(
        ([sql]: [string]) => sql.includes("merged_stellar_accounts"),
      );
      expect(insertCall).toBeDefined();
      expect(insertCall[1][0]).toBe("GMERGED...");
    });

    it("sends an ops alert email with merge details", async () => {
      await setupAndTriggerMerge("GMERGED...");

      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      const [opts] = mockSendEmail.mock.calls[0];
      expect(opts.to).toBe("ops@proxypay.io");
      expect(opts.dynamicTemplateData.merged_account).toBe("GMERGED...");
      expect(opts.dynamicTemplateData.alert_type).toBe("account_merge");
    });

    it("skips email alert when OPS_ALERT_EMAIL is not configured", async () => {
      delete process.env.OPS_ALERT_EMAIL;

      const server = makeMockServer();
      const db = makeMockDb(["GMERGED..."]);
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const monitor = createAccountMergeMonitor(db, server);
      await monitor.start();

      (server as any)._emit({ type: "account_merge", source_account: "GMERGED..." });
      await new Promise((r) => setTimeout(r, 10));
      monitor.stop();

      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it("ignores non-account_merge operations", async () => {
      const server = makeMockServer();
      const db = makeMockDb(["GACC..."]);
      const monitor = createAccountMergeMonitor(db, server);
      await monitor.start();

      (server as any)._emit({ type: "payment", source_account: "GACC..." });
      await new Promise((r) => setTimeout(r, 10));
      monitor.stop();

      // Only the initial SELECT query — no handleMerge queries
      expect((db.query as jest.Mock).mock.calls).toHaveLength(1);
    });
  });

  describe("stop()", () => {
    it("calls the stream close function for each monitored account", async () => {
      const server = makeMockServer();
      const db = makeMockDb(["GACC..."]);
      const monitor = createAccountMergeMonitor(db, server);
      await monitor.start();

      monitor.stop();

      expect((server as any)._stopMock).toHaveBeenCalled();
    });
  });
});
