import {
  TransactionBuilderService,
  PaymentParams,
  PathPaymentParams,
  ChangeTrustParams,
  ManageDataParams,
  SequenceMismatchError,
} from "../transactionBuilderService";
import * as StellarSdk from "stellar-sdk";

jest.mock("stellar-sdk");
jest.mock("../../config/stellar", () => ({
  getStellarServer: jest.fn(() => mockServer),
  getNetworkPassphrase: jest.fn(() => "Test SDF Network ; September 2015"),
}));

const mockServer = {
  fetchBaseFee: jest.fn().mockResolvedValue("100"),
  fetchTimebounds: jest.fn().mockResolvedValue({ minTime: 0, maxTime: 300 }),
  loadAccount: jest.fn(),
  submitTransaction: jest.fn(),
};

describe("TransactionBuilderService", () => {
  let service: TransactionBuilderService;
  let mockKeypair: StellarSdk.Keypair;
  let mockAccount: StellarSdk.Horizon.AccountResponse;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new TransactionBuilderService();

    mockKeypair = {
      publicKey: () => "GTEST123456789",
      secret: () => "STEST123456789",
    } as any;

    mockAccount = {
      sequence: "123456789",
      balances: [],
      operations: jest.fn(),
      data: jest.fn(),
      signers: [],
      thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
      flags: { auth_immutable: false, auth_required: false },
      id: "1",
      paging_token: "1",
      account_id: "GTEST123456789",
      subentry_count: 0,
      last_modified_ledger: 1,
      inflation_destination: null,
      home_domain: null,
    } as any;

    mockServer.loadAccount.mockResolvedValue(mockAccount);
    mockServer.submitTransaction.mockResolvedValue({
      hash: "test_hash_123",
      ledger: 12345,
      successful: true,
    });

    (StellarSdk as any).TransactionBuilder = jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      addMemo: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue({
        sign: jest.fn().mockReturnThis(),
        hash: jest.fn().mockReturnValue(Buffer.from("test_hash")),
        toXDR: jest.fn().mockReturnValue("xdr_string"),
        fee: "100",
      }),
    }));

    (StellarSdk as any).Operation = {
      payment: jest.fn().mockReturnValue({ type: "payment" }),
      pathPaymentStrictReceive: jest.fn().mockReturnValue({ type: "pathPayment" }),
      changeTrust: jest.fn().mockReturnValue({ type: "changeTrust" }),
      manageData: jest.fn().mockReturnValue({ type: "manageData" }),
    };

    (StellarSdk as any).Memo = {
      text: jest.fn().mockReturnValue({ type: "text" }),
      id: jest.fn().mockReturnValue({ type: "id" }),
      hash: jest.fn().mockReturnValue({ type: "hash" }),
      none: jest.fn().mockReturnValue({ type: "none" }),
    };

    (StellarSdk as any).Asset = {
      native: jest.fn().mockReturnValue({ isNative: () => true, getCode: () => "XLM" }),
    };

    (StellarSdk as any).BASE_FEE = "100";
  });

  describe("fetchBaseFee", () => {
    it("should fetch base fee from Horizon", async () => {
      mockServer.fetchBaseFee.mockResolvedValue("200");
      
      const fee = await (service as any).fetchBaseFee();
      
      expect(fee).toBe("200");
      expect(mockServer.fetchBaseFee).toHaveBeenCalledTimes(1);
    });

    it("should fallback to SDK default fee on fetch failure", async () => {
      mockServer.fetchBaseFee.mockRejectedValue(new Error("Network error"));
      
      const fee = await (service as any).fetchBaseFee();
      
      expect(fee).toBe("100");
    });
  });

  describe("loadAccountWithRetry", () => {
    it("should load account successfully", async () => {
      const account = await (service as any).loadAccountWithRetry("GTEST123456789");
      
      expect(account).toEqual(mockAccount);
      expect(mockServer.loadAccount).toHaveBeenCalledWith("GTEST123456789");
    });

    it("should retry on sequence mismatch error", async () => {
      const sequenceError = {
        response: {
          data: {
            extras: {
              result_codes: {
                transaction: "tx_bad_seq",
              },
            },
          },
        },
      };
      
      mockServer.loadAccount
        .mockRejectedValueOnce(sequenceError)
        .mockRejectedValueOnce(sequenceError)
        .mockResolvedValueOnce(mockAccount);

      const account = await (service as any).loadAccountWithRetry("GTEST123456789");
      
      expect(account).toEqual(mockAccount);
      expect(mockServer.loadAccount).toHaveBeenCalledTimes(3);
    });

    it("should throw after max retries on sequence mismatch", async () => {
      const sequenceError = {
        response: {
          data: {
            extras: {
              result_codes: {
                transaction: "tx_bad_seq",
              },
            },
          },
        },
      };
      
      mockServer.loadAccount.mockRejectedValue(sequenceError);

      await expect(
        (service as any).loadAccountWithRetry("GTEST123456789"),
      ).rejects.toEqual(sequenceError);
      
      expect(mockServer.loadAccount).toHaveBeenCalledTimes(4); // Initial + 3 retries
    });
  });

  describe("buildPayment", () => {
    it("should build a payment transaction", async () => {
      const params: PaymentParams = {
        sourceKeypair: mockKeypair,
        destination: "GDEST123456789",
        asset: StellarSdk.Asset.native(),
        amount: "100.50",
      };

      const result = await service.buildPayment(params);
      
      expect(result.transaction).toBeDefined();
      expect(result.fee).toBe("100");
      expect(result.sequence).toBe("123456789");
      expect(StellarSdk.Operation.payment).toHaveBeenCalledWith({
        destination: "GDEST123456789",
        asset: StellarSdk.Asset.native(),
        amount: "100.50",
      });
    });

    it("should use fee override when provided", async () => {
      const params: PaymentParams = {
        sourceKeypair: mockKeypair,
        destination: "GDEST123456789",
        asset: StellarSdk.Asset.native(),
        amount: "100.50",
        feeOverride: "500",
      };

      const result = await service.buildPayment(params);
      
      expect(result.fee).toBe("500");
      expect(mockServer.fetchBaseFee).not.toHaveBeenCalled();
    });

    it("should include memo when provided", async () => {
      const params: PaymentParams = {
        sourceKeypair: mockKeypair,
        destination: "GDEST123456789",
        asset: StellarSdk.Asset.native(),
        amount: "100.50",
        memo: StellarSdk.Memo.text("test memo"),
      };

      await service.buildPayment(params);
      
      const builder = (StellarSdk as any).TransactionBuilder.mock.results[0].value;
      expect(builder.addMemo).toHaveBeenCalled();
    });
  });

  describe("buildAndSignPayment", () => {
    it("should build and sign a payment transaction", async () => {
      const params: PaymentParams = {
        sourceKeypair: mockKeypair,
        destination: "GDEST123456789",
        asset: StellarSdk.Asset.native(),
        amount: "100.50",
      };

      const result = await service.buildAndSignPayment(params);
      
      expect(result.signedTransaction).toBeDefined();
      expect(result.hash).toBeDefined();
      expect(result.fee).toBe("100");
    });
  });

  describe("buildPathPayment", () => {
    it("should build a path payment transaction", async () => {
      const sendAsset = new StellarSdk.Asset("USD", "GISSUER123456");
      const destAsset = StellarSdk.Asset.native();
      
      const params: PathPaymentParams = {
        sourceKeypair: mockKeypair,
        destination: "GDEST123456789",
        sendAsset,
        destAsset,
        destAmount: "50.00",
        sendMax: "55.00",
      };

      const result = await service.buildPathPayment(params);
      
      expect(result.transaction).toBeDefined();
      expect(StellarSdk.Operation.pathPaymentStrictReceive).toHaveBeenCalledWith({
        sendAsset,
        sendMax: "55.00",
        destination: "GDEST123456789",
        destAsset,
        destAmount: "50.00",
        path: [],
      });
    });

    it("should include path when provided", async () => {
      const sendAsset = new StellarSdk.Asset("USD", "GISSUER123456");
      const destAsset = new StellarSdk.Asset("EUR", "GISSUER789012");
      const path = [StellarSdk.Asset.native()];
      
      const params: PathPaymentParams = {
        sourceKeypair: mockKeypair,
        destination: "GDEST123456789",
        sendAsset,
        destAsset,
        destAmount: "50.00",
        sendMax: "55.00",
        path,
      };

      await service.buildPathPayment(params);
      
      expect(StellarSdk.Operation.pathPaymentStrictReceive).toHaveBeenCalledWith(
        expect.objectContaining({
          path,
        }),
      );
    });
  });

  describe("buildAndSignPathPayment", () => {
    it("should build and sign a path payment transaction", async () => {
      const params: PathPaymentParams = {
        sourceKeypair: mockKeypair,
        destination: "GDEST123456789",
        sendAsset: new StellarSdk.Asset("USD", "GISSUER123456"),
        destAsset: StellarSdk.Asset.native(),
        destAmount: "50.00",
        sendMax: "55.00",
      };

      const result = await service.buildAndSignPathPayment(params);
      
      expect(result.signedTransaction).toBeDefined();
      expect(result.hash).toBeDefined();
    });
  });

  describe("buildChangeTrust", () => {
    it("should build a change trust transaction", async () => {
      const asset = new StellarSdk.Asset("USD", "GISSUER123456");
      
      const params: ChangeTrustParams = {
        sourceKeypair: mockKeypair,
        asset,
        limit: "1000.00",
      };

      const result = await service.buildChangeTrust(params);
      
      expect(result.transaction).toBeDefined();
      expect(StellarSdk.Operation.changeTrust).toHaveBeenCalledWith({
        asset,
        limit: "1000.00",
      });
    });

    it("should use max limit when not provided", async () => {
      const asset = new StellarSdk.Asset("USD", "GISSUER123456");
      
      const params: ChangeTrustParams = {
        sourceKeypair: mockKeypair,
        asset,
      };

      await service.buildChangeTrust(params);
      
      expect(StellarSdk.Operation.changeTrust).toHaveBeenCalledWith({
        asset,
        limit: "922337203685.4775807",
      });
    });
  });

  describe("buildAndSignChangeTrust", () => {
    it("should build and sign a change trust transaction", async () => {
      const params: ChangeTrustParams = {
        sourceKeypair: mockKeypair,
        asset: new StellarSdk.Asset("USD", "GISSUER123456"),
      };

      const result = await service.buildAndSignChangeTrust(params);
      
      expect(result.signedTransaction).toBeDefined();
      expect(result.hash).toBeDefined();
    });
  });

  describe("buildManageData", () => {
    it("should build a manage data transaction", async () => {
      const params: ManageDataParams = {
        sourceKeypair: mockKeypair,
        name: "test_key",
        value: "test_value",
      };

      const result = await service.buildManageData(params);
      
      expect(result.transaction).toBeDefined();
      expect(StellarSdk.Operation.manageData).toHaveBeenCalledWith({
        name: "test_key",
        value: "test_value",
      });
    });

    it("should handle null value for deletion", async () => {
      const params: ManageDataParams = {
        sourceKeypair: mockKeypair,
        name: "test_key",
        value: null,
      };

      await service.buildManageData(params);
      
      expect(StellarSdk.Operation.manageData).toHaveBeenCalledWith({
        name: "test_key",
        value: null,
      });
    });
  });

  describe("buildAndSignManageData", () => {
    it("should build and sign a manage data transaction", async () => {
      const params: ManageDataParams = {
        sourceKeypair: mockKeypair,
        name: "test_key",
        value: "test_value",
      };

      const result = await service.buildAndSignManageData(params);
      
      expect(result.signedTransaction).toBeDefined();
      expect(result.hash).toBeDefined();
    });
  });

  describe("submitTransaction", () => {
    it("should submit transaction successfully", async () => {
      const mockTransaction = {
        toXDR: jest.fn().mockReturnValue("xdr_string"),
      } as any;

      const result = await service.submitTransaction(mockTransaction);
      
      expect(result.hash).toBe("test_hash_123");
      expect(result.ledger).toBe(12345);
      expect(mockServer.submitTransaction).toHaveBeenCalledWith(mockTransaction);
    });

    it("should throw on submission failure", async () => {
      const mockTransaction = {
        toXDR: jest.fn().mockReturnValue("xdr_string"),
      } as any;
      
      mockServer.submitTransaction.mockRejectedValue(new Error("Submission failed"));

      await expect(service.submitTransaction(mockTransaction)).rejects.toThrow(
        "Submission failed",
      );
    });
  });

  describe("executePayment", () => {
    it("should execute payment in one call", async () => {
      const params: PaymentParams = {
        sourceKeypair: mockKeypair,
        destination: "GDEST123456789",
        asset: StellarSdk.Asset.native(),
        amount: "100.50",
      };

      const result = await service.executePayment(params);
      
      expect(result.hash).toBe("test_hash_123");
      expect(result.ledger).toBe(12345);
    });
  });

  describe("executePathPayment", () => {
    it("should execute path payment in one call", async () => {
      const params: PathPaymentParams = {
        sourceKeypair: mockKeypair,
        destination: "GDEST123456789",
        sendAsset: new StellarSdk.Asset("USD", "GISSUER123456"),
        destAsset: StellarSdk.Asset.native(),
        destAmount: "50.00",
        sendMax: "55.00",
      };

      const result = await service.executePathPayment(params);
      
      expect(result.hash).toBe("test_hash_123");
    });
  });

  describe("executeChangeTrust", () => {
    it("should execute change trust in one call", async () => {
      const params: ChangeTrustParams = {
        sourceKeypair: mockKeypair,
        asset: new StellarSdk.Asset("USD", "GISSUER123456"),
      };

      const result = await service.executeChangeTrust(params);
      
      expect(result.hash).toBe("test_hash_123");
    });
  });

  describe("executeManageData", () => {
    it("should execute manage data in one call", async () => {
      const params: ManageDataParams = {
        sourceKeypair: mockKeypair,
        name: "test_key",
        value: "test_value",
      };

      const result = await service.executeManageData(params);
      
      expect(result.hash).toBe("test_hash_123");
    });
  });
});
