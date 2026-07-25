/**
 * Unit tests for Stellar Transaction Optimizer — Issue #165
 */

import {
  estimateOptimalFee,
  isStellarTransientError,
  submitWithOptimization,
  submitBatch,
} from "../transactionOptimizer";

// ─── Mock stellar-sdk ─────────────────────────────────────────────────────────

jest.mock("stellar-sdk", () => {
  const actual = jest.requireActual("stellar-sdk");
  return {
    ...actual,
    BASE_FEE: 100,
    TransactionBuilder: {
      ...actual.TransactionBuilder,
      fromXDR: jest.fn(),
    },
  };
});

// ─── Mock config/stellar ──────────────────────────────────────────────────────

const mockSubmitTransaction = jest.fn();
const mockFetchBaseFee = jest.fn();
const mockLoadAccount = jest.fn();
const mockTransactionRecord = jest.fn();

jest.mock("../../../config/stellar", () => ({
  getStellarServer: () => ({
    submitTransaction: mockSubmitTransaction,
    fetchBaseFee: mockFetchBaseFee,
    loadAccount: mockLoadAccount,
    transactions: () => ({
      transaction: () => ({ call: mockTransactionRecord }),
    }),
  }),
  getNetworkPassphrase: () => "Test SDF Network ; September 2015",
}));

// ─── Mock circuit breaker ─────────────────────────────────────────────────────

jest.mock("../../../utils/circuitBreaker", () => ({
  executeWithCircuitBreaker: jest.fn(async ({ execute, fallback }) => {
    try {
      return await execute();
    } catch (err) {
      if (fallback) return fallback(err);
      throw err;
    }
  }),
}));

// ─── Fee estimation ───────────────────────────────────────────────────────────

describe("estimateOptimalFee", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns surge-adjusted fee based on network base fee", async () => {
    mockFetchBaseFee.mockResolvedValue(200);
    const fee = await estimateOptimalFee(1, 1.5);
    // ceil(200 * 1.5) * 1 = 300
    expect(fee).toBe(300);
  });

  it("scales with operation count", async () => {
    mockFetchBaseFee.mockResolvedValue(100);
    const fee = await estimateOptimalFee(3, 1.0);
    // ceil(100 * 1.0) * 3 = 300
    expect(fee).toBe(300);
  });

  it("falls back to BASE_FEE * operationCount on network error", async () => {
    mockFetchBaseFee.mockRejectedValue(new Error("Network error"));
    const fee = await estimateOptimalFee(2, 1.5);
    // BASE_FEE (100) * 2
    expect(fee).toBe(200);
  });

  it("uses at least BASE_FEE even if network returns lower", async () => {
    mockFetchBaseFee.mockResolvedValue(50); // below BASE_FEE of 100
    const fee = await estimateOptimalFee(1, 1.0);
    expect(fee).toBeGreaterThanOrEqual(100);
  });
});

// ─── Transient error detection ────────────────────────────────────────────────

describe("isStellarTransientError", () => {
  it("identifies timeout errors as transient", () => {
    expect(isStellarTransientError(new Error("Request timed out"))).toBe(true);
    expect(isStellarTransientError(new Error("ETIMEDOUT"))).toBe(true);
  });

  it("identifies network errors as transient", () => {
    expect(isStellarTransientError(new Error("ECONNRESET"))).toBe(true);
    expect(isStellarTransientError(new Error("ECONNREFUSED"))).toBe(true);
    expect(isStellarTransientError(new Error("ENOTFOUND"))).toBe(true);
  });

  it("identifies rate-limit errors as transient", () => {
    expect(isStellarTransientError(new Error("429 Too Many Requests"))).toBe(true);
    expect(isStellarTransientError(new Error("rate limit exceeded"))).toBe(true);
  });

  it("identifies 503/502 as transient", () => {
    expect(isStellarTransientError(new Error("503 Service Unavailable"))).toBe(true);
    expect(isStellarTransientError(new Error("502 Bad Gateway"))).toBe(true);
  });

  it("identifies tx_insufficient_fee as transient", () => {
    const err: any = new Error("Transaction failed");
    err.response = {
      data: { extras: { result_codes: { transaction: "tx_insufficient_fee" } } },
    };
    expect(isStellarTransientError(err)).toBe(true);
  });

  it("does not flag permanent errors as transient", () => {
    expect(isStellarTransientError(new Error("tx_bad_auth"))).toBe(false);
    expect(isStellarTransientError(new Error("invalid signature"))).toBe(false);
    expect(isStellarTransientError(new Error("bad sequence number"))).toBe(false);
  });
});

// ─── submitWithOptimization ────────────────────────────────────────────────────

describe("submitWithOptimization", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default: transaction parsed from XDR
    const StellarSdk = require("stellar-sdk");
    StellarSdk.TransactionBuilder.fromXDR.mockReturnValue({
      hash: jest.fn().mockReturnValue("mocked_hash"),
    });
  });

  it("returns success on first attempt", async () => {
    mockSubmitTransaction.mockResolvedValueOnce({
      hash: "abc123",
      fee_charged: "150",
      result_xdr: "AAAA",
    });
    // Polling returns confirmed
    mockTransactionRecord.mockResolvedValueOnce({
      successful: true,
      fee_charged: "150",
      result_xdr: "AAAA",
    });

    const result = await submitWithOptimization({
      envelope: "mocked_xdr_envelope",
      config: { maxRetries: 3, pollMaxAttempts: 1 },
    });

    expect(result.success).toBe(true);
    expect(result.transactionHash).toBe("abc123");
    expect(result.attempts).toBe(1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("retries on transient error and succeeds on second attempt", async () => {
    const transientErr = new Error("503 Service Unavailable");
    mockSubmitTransaction
      .mockRejectedValueOnce(transientErr)
      .mockResolvedValueOnce({
        hash: "def456",
        fee_charged: "200",
        result_xdr: "BBBB",
      });

    mockTransactionRecord.mockResolvedValueOnce({
      successful: true,
      fee_charged: "200",
    });

    const result = await submitWithOptimization({
      envelope: "mocked_xdr_envelope",
      config: { maxRetries: 3, baseDelayMs: 1, pollMaxAttempts: 1 },
    });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("stops retrying on permanent error", async () => {
    const permanentErr = new Error("tx_bad_auth: signature invalid");
    mockSubmitTransaction.mockRejectedValue(permanentErr);

    const result = await submitWithOptimization({
      envelope: "mocked_xdr_envelope",
      config: { maxRetries: 3, baseDelayMs: 1, pollMaxAttempts: 1 },
    });

    expect(result.success).toBe(false);
    // Should not have retried (permanent)
    expect(result.attempts).toBe(1);
    expect(result.error).toContain("tx_bad_auth");
  });

  it("exhausts all retries on persistent transient failures", async () => {
    mockSubmitTransaction.mockRejectedValue(new Error("ETIMEDOUT"));

    const result = await submitWithOptimization({
      envelope: "mocked_xdr_envelope",
      config: { maxRetries: 3, baseDelayMs: 1, pollMaxAttempts: 1 },
    });

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(3);
  });

  it("includes latencyMs in result", async () => {
    mockSubmitTransaction.mockResolvedValueOnce({ hash: "ghi789", fee_charged: "100" });
    mockTransactionRecord.mockResolvedValueOnce({ successful: true });

    const result = await submitWithOptimization({
      envelope: "mocked_xdr_envelope",
      config: { maxRetries: 1, pollMaxAttempts: 1 },
    });

    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ─── submitBatch ──────────────────────────────────────────────────────────────

describe("submitBatch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns empty array for empty operations list", async () => {
    const Keypair = require("stellar-sdk").Keypair;
    const kp = Keypair.random();
    const results = await submitBatch(kp, [], {});
    expect(results).toHaveLength(0);
  });

  it("maps each operation id in the result", async () => {
    // Mock the heavy dependencies so we don't hit real Horizon
    const mockBuildBatch = jest.fn().mockResolvedValue({
      toEnvelope: () => ({ toXDR: () => "mock_xdr" }),
    });

    // Spy on buildBatchTransaction within the module
    jest.spyOn(
      require("../transactionOptimizer"),
      "buildBatchTransaction",
    ).mockImplementation(mockBuildBatch);

    jest.spyOn(
      require("../transactionOptimizer"),
      "submitWithOptimization",
    ).mockResolvedValue({
      success: true,
      transactionHash: "batch_hash",
      attempts: 1,
      latencyMs: 50,
    });

    const Keypair = require("stellar-sdk").Keypair;
    const kp = Keypair.random();

    const ops: Array<{ id: string; operation: any }> = [
      { id: "op-1", operation: {} as any },
      { id: "op-2", operation: {} as any },
    ];

    const results = await submitBatch(kp, ops, { batchMaxOps: 10 });
    expect(results).toHaveLength(1); // one envelope for 2 ops
    expect(results[0].results.map((r) => r.id)).toEqual(["op-1", "op-2"]);
    expect(results[0].success).toBe(true);
  });
});
