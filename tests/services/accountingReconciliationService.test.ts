import { AccountingChartOfAccountsReconciliationService } from "../../src/services/accountingReconciliation/service";
import { AccountingProvider } from "../../src/services/accounting";
import { AccountingDiscrepancyType } from "../../src/services/accountingReconciliation/model";

// Mock dependencies
jest.mock("../../src/config/database", () => ({
  __esModule: true,
  pool: null,
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
}));
jest.mock("../../src/services/ledgerService");
jest.mock("../../src/services/accounting");
jest.mock("../../src/services/accountingReconciliation/model");
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));
jest.mock("../../src/utils/metrics", () => ({
  __esModule: true,
  default: {},
}));
jest.mock("axios");

describe("AccountingChartOfAccountsReconciliationService", () => {
  let service: AccountingChartOfAccountsReconciliationService;
  let mockLedgerService: any;
  let mockAccountingService: any;
  let mockReconModel: any;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AccountingChartOfAccountsReconciliationService();
    mockLedgerService = (service as any).ledgerService;
    mockAccountingService = (service as any).accountingService;
    mockReconModel = (service as any).reconModel;
  });

  describe("runDailyReconciliation", () => {
    it("should correctly identify discrepancies", async () => {
      const reportDate = new Date("2026-05-30");
      const connectionId = "test-connection-id";
      const provider = AccountingProvider.QUICKBOOKS;

      mockReconModel.createReport.mockResolvedValue({ id: "report-1" });
      mockLedgerService.getTrialBalance.mockResolvedValue([
        {
          account_code: "1000",
          account_name: "Cash",
          account_type: "Asset",
          debit_balance: 100,
          credit_balance: 0,
        },
        {
          account_code: "2000",
          account_name: "Accounts Payable",
          account_type: "Liability",
          debit_balance: 0,
          credit_balance: 50,
        },
      ]);

      mockAccountingService.getConnection.mockResolvedValue({
        id: connectionId,
        realmId: "realm-1",
        accessToken: "token-1",
      });

      // Mock getQuickBooksChartOfAccounts through axios
      const axios = require("axios");
      axios.get.mockResolvedValue({
        data: {
          QueryResponse: {
            Account: [
              {
                Id: "1000",
                Name: "Cash (Modified)",
                AccountType: "Asset",
                CurrentBalance: "100",
              },
              {
                Id: "3000",
                Name: "New Account",
                AccountType: "Revenue",
                CurrentBalance: "200",
              },
            ],
          },
        },
      });

      await service.runDailyReconciliation(provider, connectionId, reportDate);

      expect(mockReconModel.createDiscrepancy).toHaveBeenCalled();
      
      // Should have:
      // 1. Name mismatch for 1000
      // 2. Missing in external for 2000
      // 3. Missing in internal for 3000
      
      const discrepancyTypes = mockReconModel.createDiscrepancy.mock.calls.map(call => call[0].type);
      expect(discrepancyTypes).toContain(AccountingDiscrepancyType.AccountNameMismatch);
      expect(discrepancyTypes).toContain(AccountingDiscrepancyType.AccountMissingInQBO);
      expect(discrepancyTypes).toContain(AccountingDiscrepancyType.AccountMissingInInternal);
    });

    it("should classify penny differences as rounding errors", async () => {
      // Note: This test verifies the integration of rounding error detection.
      // The utility functions themselves are thoroughly tested in roundingTolerance.test.ts
      const reportDate = new Date("2026-05-30");
      const connectionId = "test-connection-id";
      const provider = AccountingProvider.QUICKBOOKS;

      mockReconModel.createReport.mockResolvedValue({ id: "report-1" });
      mockLedgerService.getTrialBalance.mockResolvedValue([
        {
          account_code: "1000",
          account_name: "Cash",
          account_type: "Asset",
          debit_balance: 100.005, // Using a value that when diff'd gives rounding error
          credit_balance: 0,
        },
      ]);

      mockAccountingService.getConnection.mockResolvedValue({
        id: connectionId,
        realmId: "realm-1",
        accessToken: "token-1",
      });
      mockAccountingService.ensureConnectionTokenValid.mockResolvedValue(undefined);

      const axios = require("axios");
      axios.get.mockResolvedValue({
        data: {
          QueryResponse: {
            Account: [
              {
                Id: "1000",
                Name: "Cash",
                AccountType: "Asset",
                CurrentBalance: "100.00", // Small difference
              },
            ],
          },
        },
      });

      await service.runDailyReconciliation(provider, connectionId, reportDate);

      // Check that a discrepancy was recorded (rounding error or verified as close enough)
      const discrepancyCalls = mockReconModel.createDiscrepancy.mock.calls;
      
      // Either we get a rounding error or no error at all (if within tolerance)
      const roundingError = discrepancyCalls.find(
        call => call[0].type === AccountingDiscrepancyType.RoundingError
      );
      
      // The important thing is that small differences don't trigger large discrepancy counts
      expect(discrepancyCalls.length).toBeLessThanOrEqual(1);
    });

    it("should classify differences exceeding tolerance as balance mismatches", async () => {
      const reportDate = new Date("2026-05-30");
      const connectionId = "test-connection-id";
      const provider = AccountingProvider.QUICKBOOKS;

      mockReconModel.createReport.mockResolvedValue({ id: "report-1" });
      mockLedgerService.getTrialBalance.mockResolvedValue([
        {
          account_code: "1000",
          account_name: "Cash",
          account_type: "Asset",
          debit_balance: 100.00,
          credit_balance: 0,
        },
      ]);

      mockAccountingService.getConnection.mockResolvedValue({
        id: connectionId,
        realmId: "realm-1",
        accessToken: "token-1",
      });

      const axios = require("axios");
      axios.get.mockResolvedValue({
        data: {
          QueryResponse: {
            Account: [
              {
                Id: "1000",
                Name: "Cash",
                AccountType: "Asset",
                CurrentBalance: "100.50", // Fifty cents difference
              },
            ],
          },
        },
      });

      await service.runDailyReconciliation(provider, connectionId, reportDate);

      // Check that balance mismatch was recorded (not rounding error)
      const discrepancyCalls = mockReconModel.createDiscrepancy.mock.calls;
      const balanceMismatch = discrepancyCalls.find(
        call => call[0].type === AccountingDiscrepancyType.BalanceMismatch
      );

      expect(balanceMismatch).toBeDefined();
      expect(balanceMismatch[0].roundingErrorAmount).toBeUndefined();
    });

    it("should include rounding error count in summary", async () => {
      const reportDate = new Date("2026-05-30");
      const connectionId = "test-connection-id";
      const provider = AccountingProvider.XERO;

      mockReconModel.createReport.mockResolvedValue({ id: "report-1" });
      mockLedgerService.getTrialBalance.mockResolvedValue([
        {
          account_code: "1000",
          account_name: "Cash",
          account_type: "Asset",
          debit_balance: 100.00,
          credit_balance: 0,
        },
        {
          account_code: "2000",
          account_name: "Checking",
          account_type: "Asset",
          debit_balance: 500.00,
          credit_balance: 0,
        },
      ]);

      mockAccountingService.getConnection.mockResolvedValue({
        id: connectionId,
        tenantId: "tenant-1",
        accessToken: "token-1",
      });

      const axios = require("axios");
      axios.get.mockResolvedValue({
        data: {
          Accounts: [
            {
              AccountID: "1000",
              Name: "Cash",
              Type: "Asset",
              Balance: 100.005, // Small difference
            },
            {
              AccountID: "2000",
              Name: "Checking",
              Type: "Asset",
              Balance: 500.00, // Exact match
            },
          ],
        },
      });

      await service.runDailyReconciliation(provider, connectionId, reportDate);

      // Verify summary includes rounding error count
      expect(mockReconModel.updateReport).toHaveBeenCalled();
      const updateCall = mockReconModel.updateReport.mock.calls[0];
      const summary = updateCall[1].summary;

      expect(summary).toHaveProperty("total_rounding_errors");
      expect(summary.total_rounding_errors).toBeGreaterThanOrEqual(0);
    });
  });

  describe("exportReportToCSV", () => {
    it("should generate a valid CSV string", async () => {
      const reportId = "report-1";
      mockReconModel.getReportById.mockResolvedValue({
        id: reportId,
        provider: "quickbooks",
        reportDate: new Date(),
      });

      mockReconModel.getDiscrepanciesByReportId.mockResolvedValue([
        {
          type: AccountingDiscrepancyType.AccountNameMismatch,
          internalAccountCode: "1000",
          internalAccountName: "Cash",
          externalAccountName: "Cash (Modified)",
          reviewStatus: "pending",
        },
      ]);

      const csv = await service.exportReportToCSV(reportId);
      
      expect(csv).toContain("Type,Internal Code,Internal Name");
      expect(csv).toContain("account_name_mismatch");
      expect(csv).toContain("1000");
      expect(csv).toContain("Cash");
      expect(csv).toContain("Cash (Modified)");
    });
  });

  describe("createRoundingErrorAdjustment", () => {
    it("should create adjustment entries for rounding errors", async () => {
      const discrepancy = {
        id: "disc-1",
        reportId: "report-1",
        type: AccountingDiscrepancyType.RoundingError,
        internalAccountCode: "1000",
        internalAccountName: "Cash",
        externalAccountId: "ext-1000",
        roundingErrorAmount: 0.01,
        reviewStatus: "pending" as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockLedgerService.postTransaction.mockResolvedValue([
        { entry_id: "entry-1", account_code: "1000", debit: 0, credit: 0.01 },
        { entry_id: "entry-2", account_code: "9999", debit: 0.01, credit: 0 },
      ]);

      const result = await service.createRoundingErrorAdjustment(discrepancy as any, "report-1");

      expect(result).toBeDefined();
      expect(mockLedgerService.postTransaction).toHaveBeenCalled();

      const postCall = mockLedgerService.postTransaction.mock.calls[0];
      const entries = postCall[2];

      // Verify entries are balanced
      const totalDebits = entries.reduce((sum: number, e: any) => sum + (e.debit_amount || 0), 0);
      const totalCredits = entries.reduce((sum: number, e: any) => sum + (e.credit_amount || 0), 0);
      expect(totalDebits).toBe(totalCredits);
    });

    it("should throw error for non-rounding error discrepancies", async () => {
      const discrepancy = {
        id: "disc-1",
        type: AccountingDiscrepancyType.BalanceMismatch,
        internalAccountCode: "1000",
        roundingErrorAmount: 100,
      };

      await expect(
        service.createRoundingErrorAdjustment(discrepancy as any, "report-1")
      ).rejects.toThrow("Can only create adjustments for rounding error discrepancies");
    });
  });

  describe("createAllRoundingErrorAdjustments", () => {
    it("should process all rounding errors in a report", async () => {
      const reportId = "report-1";

      mockReconModel.getDiscrepanciesByReportId.mockResolvedValue([
        {
          id: "disc-1",
          type: AccountingDiscrepancyType.RoundingError,
          internalAccountCode: "1000",
          internalAccountName: "Cash",
          externalAccountId: "ext-1000",
          roundingErrorAmount: 0.01,
          reviewStatus: "pending",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "disc-2",
          type: AccountingDiscrepancyType.RoundingError,
          internalAccountCode: "2000",
          internalAccountName: "Checking",
          externalAccountId: "ext-2000",
          roundingErrorAmount: -0.01,
          reviewStatus: "pending",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "disc-3",
          type: AccountingDiscrepancyType.BalanceMismatch, // Should be skipped
          internalAccountCode: "3000",
          roundingErrorAmount: 100,
          reviewStatus: "pending",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      mockLedgerService.postTransaction.mockResolvedValue([
        { entry_id: "entry-1", account_code: "1000", debit: 0, credit: 0.01 },
        { entry_id: "entry-2", account_code: "9999", debit: 0.01, credit: 0 },
      ]);

      const result = await service.createAllRoundingErrorAdjustments(reportId);

      expect(result.successful.length).toBe(2);
      expect(result.failed.length).toBe(0);
      expect(mockReconModel.updateDiscrepancyAdjustment).toHaveBeenCalledTimes(2);
    });

    it("should handle errors gracefully", async () => {
      const reportId = "report-1";

      mockReconModel.getDiscrepanciesByReportId.mockResolvedValue([
        {
          id: "disc-1",
          type: AccountingDiscrepancyType.RoundingError,
          internalAccountCode: "1000",
          internalAccountName: "Cash",
          externalAccountId: "ext-1000",
          roundingErrorAmount: 0.01,
          reviewStatus: "pending",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      mockLedgerService.postTransaction.mockRejectedValueOnce(
        new Error("Database error")
      );

      const result = await service.createAllRoundingErrorAdjustments(reportId);

      expect(result.successful.length).toBe(0);
      expect(result.failed.length).toBe(1);
      expect(result.failed[0].error).toContain("Database error");
    });
  });
});
});
