import { jest, describe, expect, it } from "@jest/globals";
import request from "supertest";
import { Keypair } from "stellar-sdk";

const randomKeypair = Keypair.random();
process.env.STELLAR_SIGNING_KEY = randomKeypair.secret();
process.env.STELLAR_RECEIVING_ACCOUNT = randomKeypair.publicKey();

jest.mock("spdy", () => ({
  createServer: jest.fn<any>().mockReturnValue({
    listen: jest.fn<any>((_port: any, cb: any) => { if (cb) cb(); }),
  }),
}));

jest.mock("../../src/config/redis", () => ({
  connectRedis: jest.fn<any>().mockResolvedValue(undefined),
  disconnectRedis: jest.fn<any>().mockResolvedValue(undefined),
  redisClient: { isOpen: false, ping: jest.fn<any>() },
  createRedisStore: jest.fn<any>().mockReturnValue({
    on: jest.fn<any>(),
    get: jest.fn<any>((_sid: any, cb: any) => { if (cb) cb(null, {}); }),
    set: jest.fn<any>((_sid: any, _sess: any, cb: any) => { if (cb) cb(null); }),
    destroy: jest.fn<any>((_sid: any, cb: any) => { if (cb) cb(null); }),
  }),
  SESSION_TTL_SECONDS: 86400,
}));

jest.mock("../../src/middleware/rateLimit", () => {
  const actual = jest.requireActual("../../src/middleware/rateLimit");
  return {
    ...actual,
    sep24RateLimiter: jest.fn<any>((_req: any, _res: any, next: any) => next()),
  };
});

jest.mock("../../src/config/database", () => {
  const queryMock = jest.fn<any>();
  return {
    pool: { connect: jest.fn<any>(), query: queryMock },
    queryRead: jest.fn<any>().mockResolvedValue({ rows: [] }),
    queryWrite: jest.fn<any>().mockResolvedValue({ rows: [] }),
    getPool: jest.fn<any>(),
  };
});

const app = require("../../src/index").default;

const VALID_STELLAR_ACCOUNT = (() => {
  const kp = Keypair.random();
  return kp.publicKey();
})();

describe("SEP-24 Interactive Flow", () => {
  let txId: string;
  let sep24TxId: string;

  it("GET /sep24/info returns deposit and withdraw configuration", async () => {
    const res = await request(app).get("/sep24/info");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("deposit");
    expect(res.body).toHaveProperty("withdraw");
    expect(res.body.deposit).toHaveProperty("XLM");
  });

  it("POST /sep24/deposit returns interactive url and id", async () => {
    const payload = {
      asset_code: "XLM",
      amount: "10",
      account: VALID_STELLAR_ACCOUNT,
      success_url: "https://example.com/success",
      failure_url: "https://example.com/failure",
    };

    const res = await request(app).post("/sep24/deposit").send(payload);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id");
    expect(res.body).toHaveProperty("url");
    txId = res.body.id;
  });

  it("GET /sep24/transaction/:id returns transaction state", async () => {
    expect(txId).toBeTruthy();
    const res = await request(app).get(`/sep24/transaction/${txId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "pending_user_transfer_start");
  });

  it("POST /sep24/callback/:id completed updates status and returns redirect", async () => {
    const res = await request(app)
      .post(`/sep24/callback/${txId}`)
      .send({ status: "completed", message: "Deposit successful" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("success", true);
    expect(res.body.transaction.status).toBe("completed");
    expect(res.body).toHaveProperty("redirect");
  });

  it("GET /sep24/success returns completed transaction", async () => {
    const res = await request(app).get(`/sep24/success?id=${txId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("success", true);
    expect(res.body.transaction.id).toBe(txId);
  });

  it("POST /sep24/callback/:id failed updates status and return failure redirect", async () => {
    const createRes = await request(app).post("/sep24/deposit").send({
      asset_code: "XLM",
      amount: "12",
      account: VALID_STELLAR_ACCOUNT,
      success_url: "https://example.com/success",
      failure_url: "https://example.com/failure",
    });

    expect(createRes.status).toBe(200);
    const newTxId = createRes.body.id;

    const res = await request(app)
      .post(`/sep24/callback/${newTxId}`)
      .send({ status: "failed", message: "Deposit failed" });

    expect(res.status).toBe(200);
    expect(res.body.transaction.status).toBe("failed");
    expect(res.body).toHaveProperty("redirect");
  });

  // ── SEP-24 Compliant Routes ─────────────────────────────────────────────

  it("POST /sep24/transactions/deposit/interactive returns transaction ID and redirect URL", async () => {
    const payload = {
      asset_code: "XLM",
      amount: "25",
      account: VALID_STELLAR_ACCOUNT,
      success_url: "https://example.com/success",
      failure_url: "https://example.com/failure",
    };

    const res = await request(app)
      .post("/sep24/transactions/deposit/interactive")
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id");
    expect(res.body).toHaveProperty("url");
    expect(res.body.url).toContain("transaction_id=");
    expect(typeof res.body.id).toBe("string");
    expect(typeof res.body.url).toBe("string");

    sep24TxId = res.body.id;
  });

  it("GET /sep24/transaction returns transaction details via query param", async () => {
    expect(sep24TxId).toBeTruthy();

    const res = await request(app).get(`/sep24/transaction?id=${sep24TxId}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id", sep24TxId);
    expect(res.body).toHaveProperty("kind", "deposit");
    expect(res.body).toHaveProperty("status", "pending_user_transfer_start");
    expect(res.body).toHaveProperty("asset_in", "XLM");
    expect(res.body).toHaveProperty("amount_in", "25");
  });

  it("GET /sep24/transaction returns 400 when id query param is missing", async () => {
    const res = await request(app).get("/sep24/transaction");
    expect(res.status).toBe(400);
  });

  it("GET /sep24/transaction returns 404 for non-existent id", async () => {
    const res = await request(app).get("/sep24/transaction?id=nonexistent-id");
    expect(res.status).toBe(404);
  });

  it("POST /sep24/transactions/deposit/interactive rejects unsupported asset", async () => {
    const res = await request(app)
      .post("/sep24/transactions/deposit/interactive")
      .send({
        asset_code: "INVALID_COIN",
        amount: "10",
        account: VALID_STELLAR_ACCOUNT,
      });

    expect(res.status).toBe(400);
  });

  it("POST /sep24/transactions/deposit/interactive rejects invalid Stellar account", async () => {
    const res = await request(app)
      .post("/sep24/transactions/deposit/interactive")
      .send({
        asset_code: "XLM",
        amount: "10",
        account: "NOT_A_VALID_ADDRESS",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });
});
