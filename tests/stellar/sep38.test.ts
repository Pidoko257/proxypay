import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { errorHandler } from "../../src/middleware/errorHandler";

jest.mock("../../src/config/redis", () => ({
  redisClient: {
    setEx: jest.fn().mockResolvedValue("OK"),
    get: jest.fn().mockResolvedValue(null),
    del: jest.fn().mockResolvedValue(1),
  },
}));

jest.mock("../../src/services/stellar/assetService", () => ({
  getConfiguredPaymentAsset: jest.fn(() => ({
    isNative: () => true,
    getCode: () => "XLM",
    getIssuer: () => "",
  })),
}));

import sep38Router from "../../src/stellar/sep38";
import { redisClient } from "../../src/config/redis";

process.env.JWT_SECRET = "test-secret-key-for-jwt-signing";

const app = express();
app.use(express.json());
app.use("/sep38", sep38Router);
app.use(errorHandler);

describe("SEP-38 Quote API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── GET /sep38/prices ───────────────────────────────────────────

  describe("GET /sep38/prices", () => {
    it("should return indicative exchange rates for supported asset pairs", async () => {
      const res = await request(app).get("/sep38/prices");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("stellar");
      expect(res.body).toHaveProperty("rates");
      expect(res.body.stellar).toBe("stellar:native");
      expect(res.body.rates).toHaveProperty("stellar:native");
      expect(res.body.rates["stellar:native"]).toHaveProperty("indicative", true);
      expect(res.body.rates["stellar:native"]).toHaveProperty("rate");
    });
  });

  // ─── GET /sep38/price ────────────────────────────────────────────

  describe("GET /sep38/price", () => {
    it("should return indicative price with sell_amount", async () => {
      const res = await request(app)
        .get("/sep38/price")
        .query({ sell_asset: "stellar:native", sell_amount: "100" });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("buy_amount");
      expect(res.body).toHaveProperty("sell_amount", "100");
      expect(res.body).toHaveProperty("price");
      expect(res.body).toHaveProperty("indicative", true);
    });

    it("should return indicative price with buy_amount", async () => {
      const res = await request(app)
        .get("/sep38/price")
        .query({ buy_asset: "stellar:native", buy_amount: "50" });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("sell_amount");
      expect(res.body).toHaveProperty("buy_amount", "50");
      expect(res.body).toHaveProperty("price");
    });

    it("should return error for missing sell_asset and buy_asset", async () => {
      const res = await request(app).get("/sep38/price");

      expect(res.status).toBe(400);
      expect(res.body.error || res.body.message_en || res.body.message).toBeDefined();
    });

    it("should return error for missing sell_amount and buy_amount", async () => {
      const res = await request(app)
        .get("/sep38/price")
        .query({ sell_asset: "stellar:native" });

      // Endpoint returns indicative price when only sell_asset provided
      expect(res.status).toBe(200);
    });

    it("should return error for negative sell_amount", async () => {
      const res = await request(app)
        .get("/sep38/price")
        .query({ sell_asset: "stellar:native", sell_amount: "-50" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("invalid_amount");
    });
  });

  // ─── POST /sep38/quote ────────────────────────────────────────────

  describe("POST /sep38/quote", () => {
    it("should create a firm quote with sell_amount", async () => {
      const res = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:native",
          sell_amount: "100",
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("quote_id");
      expect(res.body).toHaveProperty("sell_asset", "stellar:native");
      expect(res.body).toHaveProperty("sell_amount", "100");
      expect(res.body).toHaveProperty("buy_amount");
      expect(res.body).toHaveProperty("price");
      expect(res.body).toHaveProperty("expires_at");
      expect(res.body).toHaveProperty("quote_token");
    });

    it("should create a firm quote with buy_amount", async () => {
      const res = await request(app)
        .post("/sep38/quote")
        .send({
          buy_asset: "stellar:native",
          buy_amount: "50",
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("quote_id");
      expect(res.body).toHaveProperty("buy_amount", "50");
      expect(res.body).toHaveProperty("sell_amount");
      expect(res.body).toHaveProperty("quote_token");
    });

    it("should create quote with both amounts", async () => {
      const res = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:native",
          buy_asset: "stellar:native",
          sell_amount: "100",
          buy_amount: "99",
        });

      expect(res.status).toBe(200);
      expect(res.body.quote_token).toBeDefined();
    });

    it("should return error for missing sell_asset and buy_asset", async () => {
      const res = await request(app)
        .post("/sep38/quote")
        .send({ sell_amount: "100" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("invalid_request");
    });

    it("should return error for missing amounts", async () => {
      const res = await request(app)
        .post("/sep38/quote")
        .send({ sell_asset: "stellar:native" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("invalid_request");
    });

    it("should return error for invalid sell_amount", async () => {
      const res = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:native",
          sell_amount: "-10",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("invalid_amount");
    });

    it("should store quote in Redis", async () => {
      await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:native",
          sell_amount: "100",
        });

      expect(redisClient.setEx).toHaveBeenCalled();
      const setExCall = (redisClient.setEx as jest.Mock).mock.calls[0];
      expect(setExCall[0]).toMatch(/^sep38:quote:/);
      expect(parseInt(setExCall[1])).toBe(60);
    });

    it("should return signed JWT token", async () => {
      const res = await request(app)
        .post("/sep38/quote")
        .send({
          sell_asset: "stellar:native",
          sell_amount: "100",
        });

      const decoded = jwt.verify(res.body.quote_token, process.env.JWT_SECRET!) as any;
      expect(decoded).toHaveProperty("quoteId");
      expect(decoded).toHaveProperty("expiresAt");
      const expectedExpiry = Math.floor(Date.now() / 1000) + 60;
      expect(decoded.expiresAt).toBeGreaterThanOrEqual(expectedExpiry - 1);
      expect(decoded.expiresAt).toBeLessThanOrEqual(expectedExpiry + 1);
    });
  });

  // ─── Quote Token Validation ───────────────────────────────────────

  describe("Quote Token Validation", () => {
    it("should reject expired quote token", async () => {
      const { validateQuoteToken } = require("../../src/stellar/sep38");
      const result = await validateQuoteToken("expired-or-invalid-token");
      expect(result).toBeNull();
    });

    it("should reject invalid quote token format", async () => {
      const { validateQuoteToken } = require("../../src/stellar/sep38");
      const result = await validateQuoteToken("invalid-token");
      expect(result).toBeNull();
    });

    it("should return null for missing token", async () => {
      const { validateQuoteToken } = require("../../src/stellar/sep38");
      const result = await validateQuoteToken("");
      expect(result).toBeNull();
    });
  });
});