jest.mock("../../config/appConfig", () => ({
  getConfigValue: jest.fn((key: string) => {
    if (key === "providers.airtel.callbackSecret") return "test-airtel-secret";
    return undefined;
  }),
}));

// Mock Redis for ingestRateLimiter
jest.mock("../../config/redis", () => ({
  redisClient: {
    isOpen: false,
    eval: jest.fn(),
  },
}));

const request = require("supertest");
const express = require("express");
import airtelCallbacksRouter from "../airtelCallbacks";

describe("Airtel Callback Signature Verification", () => {
  const SECRET = "test-airtel-secret";
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use("/api/airtel", airtelCallbacksRouter);
    // Express error handler
    app.use((err: any, req: any, res: any, next: any) => {
      res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code });
    });
  });

  it("accepts a valid Airtel callback with correct bearer token", async () => {
    const response = await request(app)
      .post("/api/airtel/callback")
      .set("Authorization", `Bearer ${SECRET}`)
      .send({ status: "SUCCESS", transaction: { id: "tx-123" } })
      .expect(200);

    expect(response.body).toMatchObject({ status: "accepted" });
  });

  it("rejects a callback with a missing Authorization header", async () => {
    await request(app)
      .post("/api/airtel/callback")
      .send({ status: "SUCCESS" })
      .expect(403);
  });

  it("rejects a callback with an invalid bearer token", async () => {
    await request(app)
      .post("/api/airtel/callback")
      .set("Authorization", "Bearer wrong-token")
      .send({ status: "SUCCESS" })
      .expect(403);
  });

  it("rejects a callback with a non-Bearer auth scheme", async () => {
    await request(app)
      .post("/api/airtel/callback")
      .set("Authorization", "Basic dXNlcjpwYXNz")
      .send({ status: "SUCCESS" })
      .expect(403);
  });
});
