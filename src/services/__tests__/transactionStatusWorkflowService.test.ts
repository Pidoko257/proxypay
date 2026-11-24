import { pool } from "../../config/database";
// Import the service before the model: models/transaction imports the service,
// so loading the model first leaves TransactionStatus undefined while the
// service's static transition tables are initialised.
import {
  TransactionStatusWorkflowService,
  transactionStatusWorkflowService,
} from "../transactionStatusWorkflowService";
import { TransactionStatus } from "../../models/transaction";

jest.mock("../../config/database", () => ({
  pool: { query: jest.fn() },
}));

// Minimal in-test stand-in for the transaction_status_history table so the
// service is exercised through real SQL calls rather than an in-memory map.
type Row = {
  transaction_id: string;
  from_status: string | null;
  to_status: string;
  reason: string | null;
  explanation: string;
  updated_by: string;
  created_at: Date;
};
let table: Row[] = [];
const mockedQuery = pool.query as unknown as jest.Mock;

describe("TransactionStatusWorkflowService", () => {
  let workflowService: TransactionStatusWorkflowService;

  beforeEach(() => {
    table = [];
    mockedQuery.mockReset();
    mockedQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      if (/INSERT INTO transaction_status_history/.test(sql)) {
        const [txId, from, to, reason, explanation, updatedBy] = params as string[];
        const row: Row = {
          transaction_id: txId,
          from_status: from,
          to_status: to,
          reason,
          explanation,
          updated_by: updatedBy,
          created_at: new Date(),
        };
        table.push(row);
        return { rows: [{ created_at: row.created_at }] };
      }
      if (/FROM transaction_status_history/.test(sql)) {
        return { rows: table.filter((r) => r.transaction_id === params[0]) };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    workflowService = new TransactionStatusWorkflowService();
  });

  describe("Base TransactionStatus transitions", () => {
    it("allows valid transitions from Pending", () => {
      expect(workflowService.isValidBaseTransition(TransactionStatus.Pending, TransactionStatus.Completed)).toBe(true);
      expect(workflowService.isValidBaseTransition(TransactionStatus.Pending, TransactionStatus.Failed)).toBe(true);
      expect(workflowService.isValidBaseTransition(TransactionStatus.Pending, TransactionStatus.Cancelled)).toBe(true);
      expect(workflowService.isValidBaseTransition(TransactionStatus.Pending, TransactionStatus.Review)).toBe(true);
      expect(workflowService.isValidBaseTransition(TransactionStatus.Pending, TransactionStatus.Pending)).toBe(true);
    });

    it("rejects invalid transitions from Pending", () => {
      expect(workflowService.isValidBaseTransition(TransactionStatus.Pending, TransactionStatus.Reversed)).toBe(false);
      expect(workflowService.isValidBaseTransition(TransactionStatus.Pending, TransactionStatus.ClawedBack)).toBe(false);
      expect(workflowService.isValidBaseTransition(TransactionStatus.Pending, TransactionStatus.Dispute)).toBe(false);
    });

    it("allows valid transitions from Completed", () => {
      expect(workflowService.isValidBaseTransition(TransactionStatus.Completed, TransactionStatus.Dispute)).toBe(true);
      expect(workflowService.isValidBaseTransition(TransactionStatus.Completed, TransactionStatus.Reversed)).toBe(true);
      expect(workflowService.isValidBaseTransition(TransactionStatus.Completed, TransactionStatus.ClawedBack)).toBe(true);
    });

    it("rejects invalid transitions from Completed", () => {
      expect(workflowService.isValidBaseTransition(TransactionStatus.Completed, TransactionStatus.Pending)).toBe(false);
      expect(workflowService.isValidBaseTransition(TransactionStatus.Completed, TransactionStatus.Failed)).toBe(false);
      expect(workflowService.isValidBaseTransition(TransactionStatus.Completed, TransactionStatus.Cancelled)).toBe(false);
      expect(workflowService.isValidBaseTransition(TransactionStatus.Completed, TransactionStatus.Review)).toBe(false);
    });

    it("treats terminal states as having no outward transitions", () => {
      const terminalStatuses = [
        TransactionStatus.Failed,
        TransactionStatus.Cancelled,
        TransactionStatus.Reversed,
        TransactionStatus.ClawedBack,
      ];

      for (const terminal of terminalStatuses) {
        expect(workflowService.getAllowedBaseTransitions(terminal)).toEqual([]);
        expect(workflowService.isValidBaseTransition(terminal, TransactionStatus.Completed)).toBe(false);
        expect(workflowService.isValidBaseTransition(terminal, TransactionStatus.Pending)).toBe(false);
      }
    });

    it("allows valid transitions from Review and Dispute", () => {
      expect(workflowService.isValidBaseTransition(TransactionStatus.Review, TransactionStatus.Pending)).toBe(true);
      expect(workflowService.isValidBaseTransition(TransactionStatus.Review, TransactionStatus.Completed)).toBe(true);
      expect(workflowService.isValidBaseTransition(TransactionStatus.Review, TransactionStatus.Failed)).toBe(true);

      expect(workflowService.isValidBaseTransition(TransactionStatus.Dispute, TransactionStatus.Completed)).toBe(true);
      expect(workflowService.isValidBaseTransition(TransactionStatus.Dispute, TransactionStatus.Reversed)).toBe(true);
      expect(workflowService.isValidBaseTransition(TransactionStatus.Dispute, TransactionStatus.Failed)).toBe(true);
    });

    it("throws an error when validateBaseTransition is called with an invalid transition", () => {
      expect(() => {
        workflowService.validateBaseTransition(
          "tx-123",
          TransactionStatus.Completed,
          TransactionStatus.Pending,
        );
      }).toThrow(/Invalid transaction status transition from completed to pending/i);
    });

    it("does not throw when validateBaseTransition is called with an allowed transition", () => {
      expect(() => {
        workflowService.validateBaseTransition(
          "tx-123",
          TransactionStatus.Pending,
          TransactionStatus.Completed,
        );
      }).not.toThrow();
    });
  });

  describe("DetailedStatus transitions and history tracking", () => {
    it("transitions detailed status and tracks history", async () => {
      const entry = await workflowService.transition(
        "tx-001",
        "INITIATED",
        "KYC_VERIFYING",
        "test-runner",
        "Auto check",
      );

      expect(entry.fromStatus).toBe("INITIATED");
      expect(entry.toStatus).toBe("KYC_VERIFYING");
      expect(entry.updatedBy).toBe("test-runner");
      expect(entry.reason).toBe("Auto check");

      const history = await workflowService.getHistory("tx-001");
      expect(history.length).toBe(1);
      expect(history[0]).toEqual(entry);
    });

    it("persists history so a fresh instance (e.g. after restart or on another replica) sees it", async () => {
      await workflowService.transition("tx-002", "INITIATED", "AML_CHECKING");
      await workflowService.transition("tx-002", "AML_CHECKING", "FUNDS_RESERVED");

      const otherReplica = new TransactionStatusWorkflowService();
      const history = await otherReplica.getHistory("tx-002");

      expect(history.map((h) => h.toStatus)).toEqual(["AML_CHECKING", "FUNDS_RESERVED"]);
      expect(mockedQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO transaction_status_history"),
        expect.any(Array),
      );
    });

    it("throws error for invalid detailed status transition without writing history", async () => {
      await expect(
        workflowService.transition("tx-001", "INITIATED", "COMPLETED"),
      ).rejects.toThrow(/Invalid state transition from INITIATED to COMPLETED/i);
      expect(mockedQuery).not.toHaveBeenCalled();
    });

    it("returns explanations for statuses", () => {
      const explanation = workflowService.getStatusExplanation("COMPLETED");
      expect(explanation).toContain("successfully settled");
    });
  });
});
