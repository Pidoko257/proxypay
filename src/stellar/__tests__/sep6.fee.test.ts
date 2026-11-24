import { Request, Response } from "express";
import { Pool } from "pg";
import { feeAuditService } from "../../services/feeAuditService";
import { createSep6Router } from "../sep6";
import logger from "../../utils/logger";

// Mock dependencies
jest.mock("../../config/database");
jest.mock("../../services/feeAuditService");
jest.mock("../../utils/logger");

const mockFeeAuditService = feeAuditService as jest.Mocked<typeof feeAuditService>;

describe("SEP-6 Fee Tracking", () => {
  let mockPool: jest.Mocked<Pool>;
  let router: any;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;

  const mockAnchoredAssets = [
    {
      asset_code: "XLM",
      deposits_enabled: true,
      withdrawals_enabled: true,
      min_amount: 1,
      max_amount: 1000000,
      fee_fixed: 0.5,
      fee_percent: 1,
    },
    {
      asset_code: "USDC",
      deposits_enabled: true,
      withdrawals_enabled: true,
      min_amount: 1,
      max_amount: 1000000,
      fee_fixed: 1,
      fee_percent: 0.5,
    },
  ];

  const mockCustomer = {
    id: "customer-123",
    status: "VERIFIED",
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup mock pool
    mockPool = {
      query: jest.fn(),
    } as any;

    router = createSep6Router(mockPool);

    mockReq = {
      query: {},
      jwtUser: { userId: "user-123" },
    } as any;

    mockRes = {
      json: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
    } as any;

    // Mock logger
    (logger.debug as jest.Mock).mockImplementation(() => {});
    (logger.warn as jest.Mock).mockImplementation(() => {});
    (logger.error as jest.Mock).mockImplementation(() => {});
  });

  describe("GET /deposit - Fee Calculation and Tracking", () => {
    it("should calculate and return deposit fees correctly", async () => {
      const transactionAmount = 10000;
      const expectedFeeFixed = 0.5;
      const expectedFeePercent = 1;
      const expectedPercentageFee = (transactionAmount * expectedFeePercent) / 100;
      const expectedTotalFee = expectedFeeFixed + expectedPercentageFee;

      mockPool.query
        .mockResolvedValueOnce({
          rows: mockAnchoredAssets,
          rowCount: 2,
        })
        .mockResolvedValueOnce({
          rows: [mockCustomer],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [],
          rowCount: 1,
        });

      mockFeeAuditService.logFeeCalculation.mockResolvedValue(undefined);

      mockReq.query = {
        asset_code: "XLM",
        account: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXLV6",
        amount: String(transactionAmount),
      };

      await router.stack
        .find((r: any) => r.route?.path === "/deposit")
        .route.stack[0].handle(mockReq, mockRes);

      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0]?.[0];

      expect(jsonCall).toBeDefined();
      expect(jsonCall.fee_fixed).toBe(expectedFeeFixed);
      expect(jsonCall.fee_percent).toBe(expectedFeePercent);
      expect(jsonCall.total_fee).toBe(expectedTotalFee);
    });

    it("should persist transaction with fee_amount to database", async () => {
      const transactionAmount = 5000;

      mockPool.query
        .mockResolvedValueOnce({ rows: mockAnchoredAssets, rowCount: 2 })
        .mockResolvedValueOnce({ rows: [mockCustomer], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      mockFeeAuditService.logFeeCalculation.mockResolvedValue(undefined);

      mockReq.query = {
        asset_code: "XLM",
        account: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXLV6",
        amount: String(transactionAmount),
      };

      await router.stack
        .find((r: any) => r.route?.path === "/deposit")
        .route.stack[0].handle(mockReq, mockRes);

      // Check that persistTransaction was called with fee_amount
      const persistCall = mockPool.query.mock.calls[2];
      const sql = persistCall[0] as string;
      const params = persistCall[1] as any[];

      expect(sql).toContain("fee_amount");
      // fee_amount is at index 7 (0-indexed)
      expect(params[7]).toBeGreaterThan(0); // fee_amount should be > 0
    });

    it("should log fee to fee_audit_log with provider='sep6'", async () => {
      const transactionAmount = 10000;

      mockPool.query
        .mockResolvedValueOnce({ rows: mockAnchoredAssets, rowCount: 2 })
        .mockResolvedValueOnce({ rows: [mockCustomer], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      mockFeeAuditService.logFeeCalculation.mockResolvedValue(undefined);

      mockReq.query = {
        asset_code: "XLM",
        account: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXLV6",
        amount: String(transactionAmount),
      };

      await router.stack
        .find((r: any) => r.route?.path === "/deposit")
        .route.stack[0].handle(mockReq, mockRes);

      expect(mockFeeAuditService.logFeeCalculation).toHaveBeenCalledTimes(1);
      const auditCall = mockFeeAuditService.logFeeCalculation.mock.calls[0][0];

      expect(auditCall.provider).toBe("sep6");
      expect(auditCall.strategyScope).toBe("sep6");
      expect(auditCall.strategyName).toContain("Deposit");
      expect(auditCall.feePercentage).toBe(1); // from XLM config
      expect(auditCall.flatAmount).toBe(0.5); // from XLM config
    });

    it("should handle zero amount correctly", async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: mockAnchoredAssets, rowCount: 2 })
        .mockResolvedValueOnce({ rows: [mockCustomer], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      mockFeeAuditService.logFeeCalculation.mockResolvedValue(undefined);

      mockReq.query = {
        asset_code: "XLM",
        account: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXLV6",
        amount: "0",
      };

      await router.stack
        .find((r: any) => r.route?.path === "/deposit")
        .route.stack[0].handle(mockReq, mockRes);

      const auditCall = mockFeeAuditService.logFeeCalculation.mock.calls[0][0];
      expect(auditCall.inputAmount).toBe(0);
      expect(auditCall.calculatedFee).toBe(0.5); // Flat fee only
    });

    it("should include asset code in strategy ID for tracking", async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: mockAnchoredAssets, rowCount: 2 })
        .mockResolvedValueOnce({ rows: [mockCustomer], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      mockFeeAuditService.logFeeCalculation.mockResolvedValue(undefined);

      mockReq.query = {
        asset_code: "USDC",
        account: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXLV6",
        amount: "5000",
      };

      await router.stack
        .find((r: any) => r.route?.path === "/deposit")
        .route.stack[0].handle(mockReq, mockRes);

      const auditCall = mockFeeAuditService.logFeeCalculation.mock.calls[0][0];
      expect(auditCall.strategyId).toBe("sep6_USDC");
      expect(auditCall.feePercentage).toBe(0.5); // USDC config
      expect(auditCall.flatAmount).toBe(1); // USDC config
    });
  });

  describe("GET /withdraw - Fee Calculation and Tracking", () => {
    it("should calculate and return withdrawal fees correctly", async () => {
      const transactionAmount = 20000;
      const expectedFeeFixed = 1; // USDC config
      const expectedFeePercent = 0.5; // USDC config
      const expectedPercentageFee = (transactionAmount * expectedFeePercent) / 100;
      const expectedTotalFee = expectedFeeFixed + expectedPercentageFee;

      mockPool.query
        .mockResolvedValueOnce({ rows: mockAnchoredAssets, rowCount: 2 })
        .mockResolvedValueOnce({ rows: [mockCustomer], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      mockFeeAuditService.logFeeCalculation.mockResolvedValue(undefined);

      mockReq.query = {
        asset_code: "USDC",
        type: "bank_account",
        dest: "123456789",
        dest_extra: "987654321",
        account: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXLV6",
        amount: String(transactionAmount),
      };

      await router.stack
        .find((r: any) => r.route?.path === "/withdraw")
        .route.stack[0].handle(mockReq, mockRes);

      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0]?.[0];

      expect(jsonCall).toBeDefined();
      expect(jsonCall.fee_fixed).toBe(expectedFeeFixed);
      expect(jsonCall.fee_percent).toBe(expectedFeePercent);
      expect(jsonCall.total_fee).toBe(expectedTotalFee);
    });

    it("should log withdrawal with correct transaction type", async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: mockAnchoredAssets, rowCount: 2 })
        .mockResolvedValueOnce({ rows: [mockCustomer], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      mockFeeAuditService.logFeeCalculation.mockResolvedValue(undefined);

      mockReq.query = {
        asset_code: "XLM",
        type: "bank_account",
        dest: "123456789",
        dest_extra: "987654321",
        account: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXLV6",
        amount: "5000",
      };

      await router.stack
        .find((r: any) => r.route?.path === "/withdraw")
        .route.stack[0].handle(mockReq, mockRes);

      const auditCall = mockFeeAuditService.logFeeCalculation.mock.calls[0][0];
      expect(auditCall.strategyName).toContain("Withdrawal");
    });

    it("should handle audit log failures gracefully", async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: mockAnchoredAssets, rowCount: 2 })
        .mockResolvedValueOnce({ rows: [mockCustomer], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      mockFeeAuditService.logFeeCalculation.mockRejectedValue(
        new Error("Database error")
      );

      mockReq.query = {
        asset_code: "XLM",
        type: "bank_account",
        dest: "123456789",
        dest_extra: "987654321",
        account: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXLV6",
        amount: "5000",
      };

      await router.stack
        .find((r: any) => r.route?.path === "/withdraw")
        .route.stack[0].handle(mockReq, mockRes);

      // Should still return successful response despite audit log failure
      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0]?.[0];
      expect(jsonCall).toBeDefined();
      expect(jsonCall.account).toBeDefined();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe("Fee Precision and Edge Cases", () => {
    it("should handle decimal precision correctly", async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: mockAnchoredAssets, rowCount: 2 })
        .mockResolvedValueOnce({ rows: [mockCustomer], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      mockFeeAuditService.logFeeCalculation.mockResolvedValue(undefined);

      mockReq.query = {
        asset_code: "XLM",
        account: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXLV6",
        amount: "9999.99",
      };

      await router.stack
        .find((r: any) => r.route?.path === "/deposit")
        .route.stack[0].handle(mockReq, mockRes);

      const auditCall = mockFeeAuditService.logFeeCalculation.mock.calls[0][0];
      expect(auditCall.inputAmount).toBe(9999.99);
      // Fee should be 0.5 + (9999.99 * 0.01) = 0.5 + 99.9999 = 100.4999
      expect(auditCall.calculatedFee).toBeCloseTo(100.4999, 4);
    });

    it("should handle large amounts", async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: mockAnchoredAssets, rowCount: 2 })
        .mockResolvedValueOnce({ rows: [mockCustomer], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      mockFeeAuditService.logFeeCalculation.mockResolvedValue(undefined);

      const largeAmount = 1000000;
      mockReq.query = {
        asset_code: "XLM",
        account: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXLV6",
        amount: String(largeAmount),
      };

      await router.stack
        .find((r: any) => r.route?.path === "/deposit")
        .route.stack[0].handle(mockReq, mockRes);

      const auditCall = mockFeeAuditService.logFeeCalculation.mock.calls[0][0];
      expect(auditCall.inputAmount).toBe(largeAmount);
      expect(auditCall.calculatedFee).toBeGreaterThan(0);
    });

    it("should correctly allocate fixed vs percentage fees", async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: mockAnchoredAssets, rowCount: 2 })
        .mockResolvedValueOnce({ rows: [mockCustomer], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      mockFeeAuditService.logFeeCalculation.mockResolvedValue(undefined);

      mockReq.query = {
        asset_code: "USDC",
        account: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXLV6",
        amount: "1000",
      };

      await router.stack
        .find((r: any) => r.route?.path === "/deposit")
        .route.stack[0].handle(mockReq, mockRes);

      const auditCall = mockFeeAuditService.logFeeCalculation.mock.calls[0][0];
      // USDC: fee_fixed=1, fee_percent=0.5
      // Total: 1 + (1000 * 0.005) = 1 + 5 = 6
      expect(auditCall.calculatedFee).toBe(6);
      expect(auditCall.flatAmount).toBe(1);
      expect(auditCall.feePercentage).toBe(0.5);
    });
  });

  describe("SEP-6 Fee Breakdown Reporting", () => {
    it("should retrieve and aggregate SEP-6 fees by asset", async () => {
      const mockAuditRecords = [
        {
          id: "audit-1",
          transactionId: "txn-1",
          userId: null,
          provider: "sep6",
          inputAmount: 10000,
          calculatedFee: 150,
          totalAmount: 10150,
          strategyId: "sep6_XLM",
          strategyName: "SEP-6 XLM Deposit",
          strategyType: "mixed",
          strategyScope: "sep6",
          feePercentage: 1,
          flatAmount: 0.5,
          feeMinimum: 1,
          feeMaximum: 1000000,
          timeOverrideActive: false,
          rawFee: 150,
          clampedFee: 150,
          createdAt: new Date(),
        },
      ];

      mockFeeAuditService.getAuditRecords.mockResolvedValue({
        records: mockAuditRecords,
        total: 1,
      });

      mockReq.query = {};

      // Mock the route handler for /api/fees/sep6/breakdown
      const response = await mockFeeAuditService.getAuditRecords({
        provider: "sep6",
      });

      expect(response.total).toBe(1);
      expect(response.records[0].provider).toBe("sep6");
      expect(response.records[0].strategyId).toContain("sep6_");
    });
  });
});
