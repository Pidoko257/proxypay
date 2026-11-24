/**
 * Tests for Split Payments
 *
 * Covers:
 * - SplitPaymentService.validateRecipients() — business rule validation
 * - SplitPaymentService.createRule() — rule creation with validation
 * - SplitPaymentService.applyRule() — allocation calculation
 * - SplitPaymentService.getSplitSummary() — formatted breakdown
 * - SplitPaymentService.processTransaction()
 */

import { SplitPaymentService } from "../services/splitPaymentService";
import {
  SplitPaymentModel,
  SplitPaymentRule,
  SplitPaymentRecipient,
  SplitPaymentLedgerEntry,
  CreateRecipientInput,
} from "../models/splitPayment";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("../models/splitPayment");

const makeRecipientInput = (overrides: Partial<CreateRecipientInput> = {}): CreateRecipientInput => ({
  recipientType: "merchant",
  recipientId: "merchant-001",
  recipientLabel: "Main Merchant",
  splitType: "percentage",
  splitValue: 70,
  priority: 0,
  ...overrides,
});

const makeRecipient = (overrides: Partial<SplitPaymentRecipient> = {}): SplitPaymentRecipient => ({
  id: "rec-001",
  ruleId: "rule-001",
  recipientType: "merchant",
  recipientId: "merchant-001",
  recipientLabel: "Main Merchant",
  splitType: "percentage",
  splitValue: 70,
  priority: 0,
  createdAt: new Date(),
  ...overrides,
});

const makeRule = (overrides: Partial<SplitPaymentRule> = {}): SplitPaymentRule => ({
  id: "rule-001",
  name: "Standard Split",
  description: "70/30 merchant-platform split",
  createdBy: "user-001",
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  recipients: [
    makeRecipient({ splitValue: 70, recipientId: "merchant-001" }),
    makeRecipient({
      id: "rec-002",
      recipientId: "merchant-002",
      splitValue: 30,
      priority: 1,
    }),
  ],
  ...overrides,
});

const makeLedgerEntry = (overrides: Partial<SplitPaymentLedgerEntry> = {}): SplitPaymentLedgerEntry => ({
  id: "ledger-001",
  transactionId: "tx-001",
  ruleId: "rule-001",
  recipientType: "merchant",
  recipientId: "merchant-001",
  recipientLabel: "Main Merchant",
  splitType: "percentage",
  allocatedAmount: 700,
  currency: "XAF",
  status: "pending",
  processedAt: null,
  errorMessage: null,
  metadata: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

// ---------------------------------------------------------------------------
// SplitPaymentService unit tests
// ---------------------------------------------------------------------------

describe("SplitPaymentService", () => {
  let service: SplitPaymentService;
  let mockModel: jest.Mocked<SplitPaymentModel>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockModel = new SplitPaymentModel() as jest.Mocked<SplitPaymentModel>;
    service = new SplitPaymentService(mockModel);
  });

  // ---- validateRecipients ---------------------------------------------------

  describe("validateRecipients", () => {
    it("accepts valid percentage recipients summing to 100", () => {
      const recipients = [
        makeRecipientInput({ splitValue: 70, recipientId: "m1" }),
        makeRecipientInput({ splitValue: 30, recipientId: "m2", priority: 1 }),
      ];
      const result = service.validateRecipients(recipients);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("rejects percentage recipients not summing to 100", () => {
      const recipients = [
        makeRecipientInput({ splitValue: 60, recipientId: "m1" }),
        makeRecipientInput({ splitValue: 30, recipientId: "m2", priority: 1 }),
      ];
      const result = service.validateRecipients(recipients);
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/100/);
    });

    it("rejects negative split values", () => {
      const recipients = [makeRecipientInput({ splitValue: -10 })];
      const result = service.validateRecipients(recipients);
      expect(result.valid).toBe(false);
    });

    it("rejects empty recipients array", () => {
      const result = service.validateRecipients([]);
      expect(result.valid).toBe(false);
    });

    it("accepts fixed-amount recipients without percentage-sum validation", () => {
      const recipients = [
        makeRecipientInput({ splitType: "fixed", splitValue: 5000, recipientId: "m1" }),
        makeRecipientInput({ splitType: "fixed", splitValue: 3000, recipientId: "m2", priority: 1 }),
      ];
      const result = service.validateRecipients(recipients);
      expect(result.valid).toBe(true);
    });

    it("returns errors for invalid recipientType", () => {
      const recipients = [
        makeRecipientInput({ recipientType: "unknown" as any }),
      ];
      const result = service.validateRecipients(recipients);
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/recipientType/);
    });

    it("returns errors for empty recipientId", () => {
      const recipients = [makeRecipientInput({ recipientId: "" })];
      const result = service.validateRecipients(recipients);
      expect(result.valid).toBe(false);
    });
  });

  // ---- createRule -----------------------------------------------------------

  describe("createRule", () => {
    it("creates a rule with valid recipients", async () => {
      const rule = makeRule();
      mockModel.createRule = jest.fn().mockResolvedValue(rule);

      const recipients = [
        makeRecipientInput({ splitValue: 70, recipientId: "m1" }),
        makeRecipientInput({ splitValue: 30, recipientId: "m2", priority: 1 }),
      ];

      const result = await service.createRule("Standard Split", "70/30 split", recipients, "user-001");

      expect(mockModel.createRule).toHaveBeenCalledWith(
        "Standard Split",
        "70/30 split",
        recipients,
        "user-001",
      );
      expect(result.name).toBe("Standard Split");
    });

    it("rejects rule creation when name is empty", async () => {
      await expect(
        service.createRule("", null, [makeRecipientInput()], "user"),
      ).rejects.toThrow("name");
    });

    it("rejects rule creation with invalid recipients", async () => {
      const recipients = [makeRecipientInput({ splitValue: 60 })]; // doesn't sum to 100
      await expect(
        service.createRule("Bad Rule", null, recipients, "user"),
      ).rejects.toThrow(/Invalid recipients/);
    });
  });

  // ---- applyRule ------------------------------------------------------------

  describe("applyRule", () => {
    it("calculates correct percentage allocations", async () => {
      const rule = makeRule(); // 70/30 split
      const ledgerEntries = [
        makeLedgerEntry({ allocatedAmount: 7000 }),
        makeLedgerEntry({ id: "ledger-002", allocatedAmount: 3000 }),
      ];

      mockModel.findRuleById = jest.fn().mockResolvedValue(rule);
      mockModel.createLedgerEntries = jest.fn().mockResolvedValue(ledgerEntries);

      const result = await service.applyRule("tx-001", "rule-001", 10000, "XAF");

      expect(mockModel.findRuleById).toHaveBeenCalledWith("rule-001");
      // 70% of 10000 = 7000, 30% of 10000 = 3000
      const createCall = (mockModel.createLedgerEntries as jest.Mock).mock.calls[0];
      const allocations = createCall[2]; // third arg
      const amounts = allocations.map((a: any) => a.allocatedAmount);
      expect(amounts).toContain(7000);
      expect(amounts).toContain(3000);
      expect(result).toEqual(ledgerEntries);
    });

    it("ensures allocations sum equals total amount (dust assignment to last recipient)", async () => {
      // 3-way split with 33.33/33.33/33.34 (sums to 100)
      const threeWayRule = makeRule({
        recipients: [
          makeRecipient({ id: "r1", recipientId: "m1", splitValue: 33.33, priority: 0 }),
          makeRecipient({ id: "r2", recipientId: "m2", splitValue: 33.33, priority: 1 }),
          makeRecipient({ id: "r3", recipientId: "m3", splitValue: 33.34, priority: 2 }),
        ],
      });

      mockModel.findRuleById = jest.fn().mockResolvedValue(threeWayRule);
      mockModel.createLedgerEntries = jest.fn().mockResolvedValue([]);

      await service.applyRule("tx-001", "rule-001", 10001, "XAF");

      const createCall = (mockModel.createLedgerEntries as jest.Mock).mock.calls[0];
      const allocations = createCall[2];
      const totalAllocated = allocations.reduce((sum: number, a: any) => sum + a.allocatedAmount, 0);
      expect(totalAllocated).toBeCloseTo(10001, 2);
    });

    it("throws when rule is not found", async () => {
      mockModel.findRuleById = jest.fn().mockResolvedValue(null);
      await expect(service.applyRule("tx-001", "nonexistent", 1000, "XAF")).rejects.toThrow(
        "not found",
      );
    });

    it("throws when rule is inactive", async () => {
      mockModel.findRuleById = jest.fn().mockResolvedValue(makeRule({ isActive: false }));
      await expect(service.applyRule("tx-001", "rule-001", 1000, "XAF")).rejects.toThrow(/inact/i);
    });

    it("throws when totalAmount is 0 or negative", async () => {
      await expect(service.applyRule("tx-001", "rule-001", 0, "XAF")).rejects.toThrow();
      await expect(service.applyRule("tx-001", "rule-001", -100, "XAF")).rejects.toThrow();
    });
  });

  // ---- getSplitSummary ------------------------------------------------------

  describe("getSplitSummary", () => {
    it("returns formatted breakdown with totals", async () => {
      const entries = [
        makeLedgerEntry({ allocatedAmount: 7000, status: "completed" }),
        makeLedgerEntry({ id: "l2", allocatedAmount: 3000, status: "pending" }),
      ];

      mockModel.getLedgerForTransaction = jest.fn().mockResolvedValue(entries);

      // Actual shape: { transactionId, ruleId, totalAmount, currency, allocatedTotal, remainder, lines }
      const result = await service.getSplitSummary("tx-001");

      expect(result).toHaveProperty("transactionId", "tx-001");
      expect(result).toHaveProperty("lines");
      expect(result).toHaveProperty("totalAmount");
      expect(result.totalAmount).toBe(10000);   // allocatedTotal == sum of entries
      expect(result.lines).toHaveLength(2);
    });

    it("returns empty summary when no splits exist", async () => {
      mockModel.getLedgerForTransaction = jest.fn().mockResolvedValue([]);
      const result = await service.getSplitSummary("tx-001");
      expect(result.lines).toHaveLength(0);
      expect(result.totalAmount).toBe(0);
    });
  });

  // ---- processTransaction ---------------------------------------------------

  describe("processTransaction", () => {
    it("applies rule and marks entries as processing", async () => {
      const rule = makeRule();
      const entries = [
        makeLedgerEntry({ id: "l1", status: "pending" }),
        makeLedgerEntry({ id: "l2", status: "pending" }),
      ];

      mockModel.findRuleById = jest.fn().mockResolvedValue(rule);
      mockModel.createLedgerEntries = jest.fn().mockResolvedValue(entries);
      mockModel.updateLedgerEntryStatus = jest.fn().mockResolvedValue({
        ...entries[0],
        status: "processing",
      });

      await service.processTransaction("tx-001", "rule-001", 10000, "XAF");

      expect(mockModel.updateLedgerEntryStatus).toHaveBeenCalledTimes(entries.length);
      expect(mockModel.updateLedgerEntryStatus).toHaveBeenCalledWith("l1", "processing");
      expect(mockModel.updateLedgerEntryStatus).toHaveBeenCalledWith("l2", "processing");
    });
  });
});
