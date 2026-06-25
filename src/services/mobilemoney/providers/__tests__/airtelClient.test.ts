import { AxiosInstance } from "axios";
import { AirtelClient } from "../airtelClient";
import { ERROR_CODES } from "../../../../constants/errorCodes";

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

const redisStore: Record<string, string> = {};
jest.mock("../../../../config/redis", () => ({
  redisClient: {
    get:   jest.fn(async (key: string) => redisStore[key] ?? null),
    setEx: jest.fn(async (key: string, _ttl: number, value: string) => { redisStore[key] = value; }),
    del:   jest.fn(async (key: string) => { delete redisStore[key]; }),
  },
}));

// ---------------------------------------------------------------------------
// Mock HTTP client factory
// ---------------------------------------------------------------------------

function makeHttp(handlers: {
  post?: jest.Mock;
  get?:  jest.Mock;
}): AxiosInstance {
  return {
    post: handlers.post ?? jest.fn(),
    get:  handlers.get  ?? jest.fn(),
  } as unknown as AxiosInstance;
}

const TOKEN_RESPONSE = { data: { access_token: "test-token", expires_in: 3600 } };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AirtelClient", () => {
  beforeEach(() => {
    // Clear Redis store between tests
    for (const k of Object.keys(redisStore)) delete redisStore[k];
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // OAuth2 token management
  // -------------------------------------------------------------------------

  describe("getAccessToken", () => {
    it("fetches a token from the API and caches it in Redis", async () => {
      const post = jest.fn().mockResolvedValue(TOKEN_RESPONSE);
      const client = new AirtelClient({}, makeHttp({ post }));

      const token = await client.getAccessToken();

      expect(token).toBe("test-token");
      expect(post).toHaveBeenCalledWith(
        "/auth/oauth2/token",
        { grant_type: "client_credentials" },
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Basic /) }) }),
      );
      expect(redisStore["airtel:oauth2:token"]).toBe("test-token");
    });

    it("returns the cached token from Redis without calling the API", async () => {
      redisStore["airtel:oauth2:token"] = "cached-token";
      const post = jest.fn();
      const client = new AirtelClient({}, makeHttp({ post }));

      const token = await client.getAccessToken();

      expect(token).toBe("cached-token");
      expect(post).not.toHaveBeenCalled();
    });

    it("refreshes when the Redis cache is empty", async () => {
      const post = jest.fn().mockResolvedValue(TOKEN_RESPONSE);
      const client = new AirtelClient({}, makeHttp({ post }));

      await client.getAccessToken();
      expect(post).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // RequestToPay
  // -------------------------------------------------------------------------

  describe("requestToPay", () => {
    it("returns success with transactionId on 200 response", async () => {
      const post = jest.fn()
        .mockResolvedValueOnce(TOKEN_RESPONSE)
        .mockResolvedValueOnce({
          data: {
            status: { success: true, code: "200" },
            data: { transaction: { id: "txn-001", status: "TS" } },
          },
        });

      const client = new AirtelClient({}, makeHttp({ post }));
      const result = await client.requestToPay({
        msisdn: "256700000001",
        amount: 5000,
        currency: "UGX",
        reference: "ref-001",
        country: "UG",
      });

      expect(result.success).toBe(true);
      expect(result.transactionId).toBe("txn-001");
    });

    it("normalizes ESB000008 (insufficient funds) to INSUFFICIENT_FUNDS", async () => {
      const post = jest.fn()
        .mockResolvedValueOnce(TOKEN_RESPONSE)
        .mockResolvedValueOnce({
          data: {
            status: { success: false, code: "ESB000008", message: "Insufficient balance" },
          },
        });

      const client = new AirtelClient({}, makeHttp({ post }));
      const result = await client.requestToPay({
        msisdn: "256700000001",
        amount: 999999,
        currency: "UGX",
        reference: "ref-002",
        country: "UG",
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(ERROR_CODES.INSUFFICIENT_FUNDS);
      expect(result.errorMessage).toBe("Insufficient balance");
    });

    it("normalizes ESB000011 (limit exceeded) to LIMIT_EXCEEDED", async () => {
      const post = jest.fn()
        .mockResolvedValueOnce(TOKEN_RESPONSE)
        .mockResolvedValueOnce({
          data: { status: { success: false, code: "ESB000011", message: "Daily limit exceeded" } },
        });

      const client = new AirtelClient({}, makeHttp({ post }));
      const result = await client.requestToPay({
        msisdn: "256700000001",
        amount: 100,
        currency: "UGX",
        reference: "ref-003",
        country: "UG",
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(ERROR_CODES.LIMIT_EXCEEDED);
    });

    it("returns PROVIDER_ERROR for unknown Airtel codes", async () => {
      const post = jest.fn()
        .mockResolvedValueOnce(TOKEN_RESPONSE)
        .mockResolvedValueOnce({
          data: { status: { success: false, code: "ZZZUNKNOWN" } },
        });

      const client = new AirtelClient({}, makeHttp({ post }));
      const result = await client.requestToPay({
        msisdn: "256700000001", amount: 100, currency: "UGX", reference: "ref-004", country: "UG",
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(ERROR_CODES.PROVIDER_ERROR);
    });

    it("handles network errors and returns PROVIDER_ERROR", async () => {
      const post = jest.fn()
        .mockResolvedValueOnce(TOKEN_RESPONSE)
        .mockRejectedValueOnce(new Error("Network timeout"));

      const client = new AirtelClient({}, makeHttp({ post }));
      const result = await client.requestToPay({
        msisdn: "256700000001", amount: 100, currency: "UGX", reference: "ref-005", country: "UG",
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(ERROR_CODES.PROVIDER_ERROR);
      expect(result.errorMessage).toBe("Network timeout");
    });
  });

  // -------------------------------------------------------------------------
  // Disburse
  // -------------------------------------------------------------------------

  describe("disburse", () => {
    it("returns success with transactionId on 200 response", async () => {
      const post = jest.fn()
        .mockResolvedValueOnce(TOKEN_RESPONSE)
        .mockResolvedValueOnce({
          data: {
            status: { success: true, code: "200" },
            data: { transaction: { id: "dis-001" } },
          },
        });

      const client = new AirtelClient({}, makeHttp({ post }));
      const result = await client.disburse({
        msisdn: "255700000001",
        amount: 10000,
        currency: "TZS",
        reference: "dis-ref-001",
      });

      expect(result.success).toBe(true);
      expect(result.transactionId).toBe("dis-001");
    });

    it("maps ESB000010 (subscriber not found) to NOT_FOUND", async () => {
      const post = jest.fn()
        .mockResolvedValueOnce(TOKEN_RESPONSE)
        .mockResolvedValueOnce({
          data: { status: { success: false, code: "ESB000010", message: "Subscriber not found" } },
        });

      const client = new AirtelClient({}, makeHttp({ post }));
      const result = await client.disburse({
        msisdn: "255799999999", amount: 100, currency: "TZS", reference: "dis-ref-002",
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(ERROR_CODES.NOT_FOUND);
    });
  });

  // -------------------------------------------------------------------------
  // getTransactionStatus
  // -------------------------------------------------------------------------

  describe("getTransactionStatus", () => {
    it("maps TS to completed", async () => {
      const post = jest.fn().mockResolvedValue(TOKEN_RESPONSE);
      const get  = jest.fn().mockResolvedValue({
        data: { data: { transaction: { id: "txn-001", status: "TS" } } },
      });

      const client = new AirtelClient({}, makeHttp({ post, get }));
      const status = await client.getTransactionStatus("txn-001");

      expect(status.status).toBe("completed");
      expect(status.transactionId).toBe("txn-001");
    });

    it("maps TF to failed", async () => {
      const post = jest.fn().mockResolvedValue(TOKEN_RESPONSE);
      const get  = jest.fn().mockResolvedValue({
        data: { data: { transaction: { id: "txn-002", status: "TF" } } },
      });

      const client = new AirtelClient({}, makeHttp({ post, get }));
      const status = await client.getTransactionStatus("txn-002");

      expect(status.status).toBe("failed");
    });

    it("returns unknown on network error", async () => {
      const post = jest.fn().mockResolvedValue(TOKEN_RESPONSE);
      const get  = jest.fn().mockRejectedValue(new Error("timeout"));

      const client = new AirtelClient({}, makeHttp({ post, get }));
      const status = await client.getTransactionStatus("txn-003");

      expect(status.status).toBe("unknown");
    });
  });
});
