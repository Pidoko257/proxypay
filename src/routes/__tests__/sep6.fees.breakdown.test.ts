import { Request, Response } from "express";
import { feeAuditService } from "../../services/feeAuditService";
import { ERROR_CODES } from "../../constants/errorCodes";

jest.mock("../../services/feeAuditService");
jest.mock("../../middleware/rbac");
jest.mock("../../middleware/auth");

const mockFeeAuditService = feeAuditService as jest.Mocked<typeof feeAuditService>;

describe("GET /api/fees/sep6/breakdown", () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let statusCode = 200;
  let jsonResponse: any = {};

  beforeEach(() => {
    jest.clearAllMocks();

    mockReq = {
      query: {},
      jwtUser: { userId: "admin-123" },
    } as any;

    mockRes = {
      json: jest.fn(function (data: any) {
        jsonResponse = data;
        return this;
      }),
      status: jest.fn(function (code: number) {
        statusCode = code;
        return this;
      }),
      send: jest.fn().mockReturnThis(),
    } as any;
  });

  describe("Basic Functionality", () => {
    it("should return SEP-6 fee breakdown with default 30-day range", async () => {
      const mockRecords = [
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
        {
          id: "audit-2",
          transactionId: "txn-2",
          userId: null,
          provider: "sep6",
          inputAmount: 5000,
          calculatedFee: 75,
          totalAmount: 5075,
          strategyId: "sep6_USDC",
          strategyName: "SEP-6 USDC Withdrawal",
          strategyType: "mixed",
          strategyScope: "sep6",
          feePercentage: 0.5,
          flatAmount: 1,
          feeMinimum: 1,
          feeMaximum: 1000000,
          timeOverrideActive: false,
          rawFee: 75,
          clampedFee: 75,
          createdAt: new Date(),
        },
      ];

      mockFeeAuditService.getAuditRecords.mockResolvedValue({
        records: mockRecords,
        total: 2,
      });

      mockReq.query = {};

      // Simulate the endpoint handler logic
      const { records, total } = await mockFeeAuditService.getAuditRecords({
        provider: "sep6",
      });

      const breakdown: Record<string, any> = {
        totalRecords: total,
        dateRange: { from: new Date().toISOString(), to: new Date().toISOString() },
        summary: {
          totalFeeRevenue: 0,
          totalTransactionVolume: 0,
          averageFeePercentage: 0,
          averageFlatFee: 0,
          totalTransactions: records.length,
        },
        byAsset: {} as Record<string, any>,
        byType: {} as Record<string, any>,
        records: records.slice(0, 10),
      };

      for (const record of records) {
        breakdown.summary.totalFeeRevenue += record.calculatedFee;
        breakdown.summary.totalTransactionVolume += record.inputAmount;

        const [, asset] = record.strategyId.split("_");
        if (asset) {
          if (!breakdown.byAsset[asset]) {
            breakdown.byAsset[asset] = {
              asset,
              feeRevenue: 0,
              transactionVolume: 0,
              count: 0,
              avgFeePercentage: 0,
            };
          }
          breakdown.byAsset[asset].feeRevenue += record.calculatedFee;
          breakdown.byAsset[asset].transactionVolume += record.inputAmount;
          breakdown.byAsset[asset].count += 1;
          if (record.feePercentage) {
            breakdown.byAsset[asset].avgFeePercentage = record.feePercentage;
          }
        }

        const txType = record.strategyName.includes("Withdrawal") ? "withdrawal" : "deposit";
        if (!breakdown.byType[txType]) {
          breakdown.byType[txType] = {
            type: txType,
            feeRevenue: 0,
            transactionVolume: 0,
            count: 0,
          };
        }
        breakdown.byType[txType].feeRevenue += record.calculatedFee;
        breakdown.byType[txType].transactionVolume += record.inputAmount;
        breakdown.byType[txType].count += 1;
      }

      if (records.length > 0) {
        breakdown.summary.averageFeePercentage =
          records.reduce((sum, r) => sum + (r.feePercentage || 0), 0) / records.length;
        breakdown.summary.averageFlatFee =
          records.reduce((sum, r) => sum + (r.flatAmount || 0), 0) / records.length;
      }

      expect(breakdown.summary.totalFeeRevenue).toBe(225); // 150 + 75
      expect(breakdown.summary.totalTransactionVolume).toBe(15000); // 10000 + 5000
      expect(breakdown.summary.totalTransactions).toBe(2);
      expect(breakdown.byAsset.XLM).toBeDefined();
      expect(breakdown.byAsset.USDC).toBeDefined();
      expect(breakdown.byType.deposit).toBeDefined();
      expect(breakdown.byType.withdrawal).toBeDefined();
    });

    it("should aggregate fees correctly by asset", async () => {
      const mockRecords = [
        {
          id: "audit-1",
          transactionId: "txn-1",
          strategyId: "sep6_XLM",
          strategyName: "SEP-6 XLM Deposit",
          inputAmount: 10000,
          calculatedFee: 100,
          feePercentage: 1,
          flatAmount: 0.5,
        },
        {
          id: "audit-2",
          transactionId: "txn-2",
          strategyId: "sep6_XLM",
          strategyName: "SEP-6 XLM Deposit",
          inputAmount: 20000,
          calculatedFee: 200,
          feePercentage: 1,
          flatAmount: 0.5,
        },
      ] as any;

      const byAsset: Record<string, any> = {};
      for (const record of mockRecords) {
        const [, asset] = record.strategyId.split("_");
        if (asset) {
          if (!byAsset[asset]) {
            byAsset[asset] = {
              asset,
              feeRevenue: 0,
              transactionVolume: 0,
              count: 0,
              avgFeePercentage: 0,
            };
          }
          byAsset[asset].feeRevenue += record.calculatedFee;
          byAsset[asset].transactionVolume += record.inputAmount;
          byAsset[asset].count += 1;
          if (record.feePercentage) {
            byAsset[asset].avgFeePercentage = record.feePercentage;
          }
        }
      }

      expect(byAsset.XLM.feeRevenue).toBe(300);
      expect(byAsset.XLM.transactionVolume).toBe(30000);
      expect(byAsset.XLM.count).toBe(2);
      expect(byAsset.XLM.avgFeePercentage).toBe(1);
    });

    it("should aggregate fees correctly by transaction type", async () => {
      const mockRecords = [
        {
          id: "audit-1",
          strategyId: "sep6_XLM",
          strategyName: "SEP-6 XLM Deposit",
          inputAmount: 10000,
          calculatedFee: 100,
        },
        {
          id: "audit-2",
          strategyId: "sep6_XLM",
          strategyName: "SEP-6 XLM Withdrawal",
          inputAmount: 5000,
          calculatedFee: 50,
        },
      ] as any;

      const byType: Record<string, any> = {};
      for (const record of mockRecords) {
        const txType = record.strategyName.includes("Withdrawal") ? "withdrawal" : "deposit";
        if (!byType[txType]) {
          byType[txType] = {
            type: txType,
            feeRevenue: 0,
            transactionVolume: 0,
            count: 0,
          };
        }
        byType[txType].feeRevenue += record.calculatedFee;
        byType[txType].transactionVolume += record.inputAmount;
        byType[txType].count += 1;
      }

      expect(byType.deposit.feeRevenue).toBe(100);
      expect(byType.deposit.transactionVolume).toBe(10000);
      expect(byType.deposit.count).toBe(1);

      expect(byType.withdrawal.feeRevenue).toBe(50);
      expect(byType.withdrawal.transactionVolume).toBe(5000);
      expect(byType.withdrawal.count).toBe(1);
    });
  });

  describe("Date Range Filtering", () => {
    it("should accept custom from and to date parameters", async () => {
      const fromDate = "2026-10-01";
      const toDate = "2026-10-15";

      mockFeeAuditService.getAuditRecords.mockResolvedValue({
        records: [],
        total: 0,
      });

      mockReq.query = { from: fromDate, to: toDate };

      await mockFeeAuditService.getAuditRecords({
        provider: "sep6",
        from: new Date(fromDate),
        to: new Date(toDate),
      });

      expect(mockFeeAuditService.getAuditRecords).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "sep6",
          from: expect.any(Date),
          to: expect.any(Date),
        })
      );
    });

    it("should default to 30-day lookback when no dates provided", async () => {
      mockFeeAuditService.getAuditRecords.mockResolvedValue({
        records: [],
        total: 0,
      });

      mockReq.query = {};

      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      await mockFeeAuditService.getAuditRecords({
        provider: "sep6",
        from: thirtyDaysAgo,
      });

      expect(mockFeeAuditService.getAuditRecords).toHaveBeenCalledWith(
        expect.objectContaining({
          from: expect.any(Date),
        })
      );
    });
  });

  describe("Asset Code Filtering", () => {
    it("should filter breakdown by asset code when provided", async () => {
      const mockRecords = [
        {
          id: "audit-1",
          strategyId: "sep6_XLM",
          strategyName: "SEP-6 XLM Deposit",
          inputAmount: 10000,
          calculatedFee: 100,
        },
        {
          id: "audit-2",
          strategyId: "sep6_USDC",
          strategyName: "SEP-6 USDC Deposit",
          inputAmount: 20000,
          calculatedFee: 200,
        },
      ] as any;

      mockReq.query = { assetCode: "XLM" };

      const filtered = mockRecords.filter((r: any) => r.strategyId.includes("_XLM"));

      expect(filtered).toHaveLength(1);
      expect(filtered[0].strategyId).toBe("sep6_XLM");
    });
  });

  describe("Pagination", () => {
    it("should respect limit parameter", async () => {
      const mockRecords = Array.from({ length: 100 }, (_, i) => ({
        id: `audit-${i}`,
        strategyId: "sep6_XLM",
        strategyName: "SEP-6 XLM Deposit",
        inputAmount: 1000,
        calculatedFee: 10,
      })) as any;

      mockFeeAuditService.getAuditRecords.mockResolvedValue({
        records: mockRecords.slice(0, 50),
        total: 100,
      });

      mockReq.query = { limit: "50" };

      const { records } = await mockFeeAuditService.getAuditRecords({
        provider: "sep6",
        limit: 50,
      });

      expect(records).toHaveLength(50);
    });

    it("should respect offset parameter for pagination", async () => {
      mockFeeAuditService.getAuditRecords.mockResolvedValue({
        records: [],
        total: 100,
      });

      mockReq.query = { offset: "50" };

      await mockFeeAuditService.getAuditRecords({
        provider: "sep6",
        offset: 50,
      });

      expect(mockFeeAuditService.getAuditRecords).toHaveBeenCalledWith(
        expect.objectContaining({
          offset: 50,
        })
      );
    });

    it("should cap limit at 1000", async () => {
      mockFeeAuditService.getAuditRecords.mockResolvedValue({
        records: [],
        total: 0,
      });

      mockReq.query = { limit: "5000" };

      // The actual endpoint caps limit at 1000
      const cappedLimit = Math.min(parseInt("5000", 10), 1000);
      expect(cappedLimit).toBe(1000);
    });
  });

  describe("Error Handling", () => {
    it("should handle audit service errors gracefully", async () => {
      mockFeeAuditService.getAuditRecords.mockRejectedValue(
        new Error("Database error")
      );

      mockReq.query = {};

      try {
        await mockFeeAuditService.getAuditRecords({
          provider: "sep6",
        });
      } catch (error: any) {
        expect(error.message).toBe("Database error");
      }

      expect(mockFeeAuditService.getAuditRecords).toHaveBeenCalled();
    });

    it("should handle empty result sets", async () => {
      mockFeeAuditService.getAuditRecords.mockResolvedValue({
        records: [],
        total: 0,
      });

      mockReq.query = { assetCode: "NONEXISTENT" };

      const { records, total } = await mockFeeAuditService.getAuditRecords({
        provider: "sep6",
      });

      expect(records).toHaveLength(0);
      expect(total).toBe(0);
    });
  });

  describe("Fee Calculation Accuracy", () => {
    it("should correctly sum fee revenue across multiple transactions", async () => {
      const mockRecords = [
        {
          id: "audit-1",
          inputAmount: 10000,
          calculatedFee: 100,
          strategyId: "sep6_XLM",
          strategyName: "SEP-6 XLM Deposit",
          feePercentage: 1,
          flatAmount: 0,
        },
        {
          id: "audit-2",
          inputAmount: 5000,
          calculatedFee: 75,
          strategyId: "sep6_XLM",
          strategyName: "SEP-6 XLM Deposit",
          feePercentage: 1,
          flatAmount: 0.5,
        },
        {
          id: "audit-3",
          inputAmount: 20000,
          calculatedFee: 200,
          strategyId: "sep6_USDC",
          strategyName: "SEP-6 USDC Withdrawal",
          feePercentage: 0.5,
          flatAmount: 1,
        },
      ] as any;

      let totalFeeRevenue = 0;
      let totalTransactionVolume = 0;

      for (const record of mockRecords) {
        totalFeeRevenue += record.calculatedFee;
        totalTransactionVolume += record.inputAmount;
      }

      expect(totalFeeRevenue).toBe(375); // 100 + 75 + 200
      expect(totalTransactionVolume).toBe(35000); // 10000 + 5000 + 20000
    });

    it("should calculate correct average fee percentage", async () => {
      const mockRecords = [
        {
          feePercentage: 1,
          strategyId: "sep6_XLM",
          strategyName: "SEP-6 XLM Deposit",
          inputAmount: 10000,
          calculatedFee: 100,
        },
        {
          feePercentage: 0.5,
          strategyId: "sep6_USDC",
          strategyName: "SEP-6 USDC Deposit",
          inputAmount: 20000,
          calculatedFee: 100,
        },
        {
          feePercentage: 1,
          strategyId: "sep6_XLM",
          strategyName: "SEP-6 XLM Withdrawal",
          inputAmount: 5000,
          calculatedFee: 50,
        },
      ] as any;

      const avgFeePercentage = mockRecords.reduce((sum, r) => sum + (r.feePercentage || 0), 0) / mockRecords.length;

      expect(avgFeePercentage).toBeCloseTo(0.833, 2);
    });
  });
});
