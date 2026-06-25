/**
 * Pact Consumer Contract Tests — proxypay-frontend → ProxyPay API
 *
 * Defines the contract between the frontend (consumer) and the ProxyPay
 * backend (provider) for the 5 most critical API interactions.
 *
 * Generated pact file: pacts/proxypay-frontend-ProxyPayAPI.json
 */
import path from "path";
import { PactV3, MatchersV3 } from "@pact-foundation/pact";
import axios from "axios";

const { like, string, integer } = MatchersV3;

const provider = new PactV3({
  consumer: "proxypay-frontend",
  provider: "ProxyPayAPI",
  dir: path.resolve(__dirname, "../../pacts"),
  logLevel: "warn",
});

const BEARER_TOKEN = "Bearer test-jwt-token";

// ─────────────────────────────────────────────────────────────────────────────
// 1. POST /api/auth/login — user authentication
// ─────────────────────────────────────────────────────────────────────────────
describe("ProxyPay API Contract — proxypay-frontend consumer", () => {
  describe("POST /api/auth/login — authenticate user", () => {
    it("returns a JWT token for valid credentials", async () => {
      await provider
        .given("a registered user exists with phone +237670000001")
        .uponReceiving("a login request with valid credentials")
        .withRequest({
          method: "POST",
          path: "/api/auth/login",
          headers: { "Content-Type": "application/json" },
          body: {
            phone_number: like("+237670000001"),
            password: like("ValidPass123!"),
          },
        })
        .willRespondWith({
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: {
            token: like("eyJhbGciOiJIUzI1NiJ9.test"),
            user: {
              id: like("user-uuid-001"),
              phone_number: like("+237670000001"),
            },
          },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.post(
            `${mockServer.url}/api/auth/login`,
            { phone_number: "+237670000001", password: "ValidPass123!" },
            { headers: { "Content-Type": "application/json" } },
          );
          expect(res.status).toBe(200);
          expect(res.data.token).toBeDefined();
          expect(res.data.user.phone_number).toBe("+237670000001");
        });
    });

    it("returns 401 for invalid credentials", async () => {
      await provider
        .given("no user exists with phone +237670000099")
        .uponReceiving("a login request with invalid credentials")
        .withRequest({
          method: "POST",
          path: "/api/auth/login",
          headers: { "Content-Type": "application/json" },
          body: {
            phone_number: like("+237670000099"),
            password: like("WrongPassword1!"),
          },
        })
        .willRespondWith({
          status: 401,
          headers: { "Content-Type": "application/json" },
          body: { error: like("Invalid credentials") },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.post(
            `${mockServer.url}/api/auth/login`,
            { phone_number: "+237670000099", password: "WrongPassword1!" },
            { headers: { "Content-Type": "application/json" }, validateStatus: () => true },
          );
          expect(res.status).toBe(401);
        });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. POST /api/transactions/deposit — initiate deposit
  // ───────────────────────────────────────────────────────────────────────────
  describe("POST /api/transactions/deposit — initiate deposit", () => {
    it("creates a deposit transaction and returns pending status", async () => {
      await provider
        .given("an authenticated user with sufficient mobile money balance")
        .uponReceiving("a request to deposit mobile money to Stellar")
        .withRequest({
          method: "POST",
          path: "/api/transactions/deposit",
          headers: {
            "Content-Type": "application/json",
            Authorization: string(BEARER_TOKEN),
          },
          body: {
            amount: like(5000),
            currency: like("XAF"),
            provider: like("mtn"),
            phone_number: like("+237670000001"),
            stellar_address: like("GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3"),
          },
        })
        .willRespondWith({
          status: 201,
          headers: { "Content-Type": "application/json" },
          body: {
            id: like("txn-uuid-001"),
            status: like("pending"),
            amount: like(5000),
            currency: like("XAF"),
            provider: like("mtn"),
            created_at: like("2026-06-25T08:00:00.000Z"),
          },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.post(
            `${mockServer.url}/api/transactions/deposit`,
            {
              amount: 5000,
              currency: "XAF",
              provider: "mtn",
              phone_number: "+237670000001",
              stellar_address:
                "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3",
            },
            { headers: { "Content-Type": "application/json", Authorization: BEARER_TOKEN } },
          );
          expect(res.status).toBe(201);
          expect(res.data.status).toBe("pending");
          expect(res.data.id).toBeDefined();
        });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. GET /api/transactions/:id — fetch transaction by ID
  // ───────────────────────────────────────────────────────────────────────────
  describe("GET /api/transactions/:id — get transaction details", () => {
    const TX_ID = "txn-uuid-001";

    it("returns full transaction details for a completed deposit", async () => {
      await provider
        .given(`a completed deposit transaction with id ${TX_ID}`)
        .uponReceiving("a request to get transaction details")
        .withRequest({
          method: "GET",
          path: `/api/transactions/${TX_ID}`,
          headers: { Authorization: string(BEARER_TOKEN) },
        })
        .willRespondWith({
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: {
            id: like(TX_ID),
            status: like("completed"),
            amount: like(5000),
            currency: like("XAF"),
            provider: like("mtn"),
            stellar_tx_hash: like("abc123def456"),
            created_at: like("2026-06-25T08:00:00.000Z"),
            updated_at: like("2026-06-25T08:01:00.000Z"),
          },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.get(
            `${mockServer.url}/api/transactions/${TX_ID}`,
            { headers: { Authorization: BEARER_TOKEN } },
          );
          expect(res.status).toBe(200);
          expect(res.data.id).toBe(TX_ID);
          expect(res.data.stellar_tx_hash).toBeDefined();
        });
    });

    it("returns 404 for a non-existent transaction", async () => {
      await provider
        .given("no transaction exists with id txn-not-found")
        .uponReceiving("a request to get a non-existent transaction")
        .withRequest({
          method: "GET",
          path: "/api/transactions/txn-not-found",
          headers: { Authorization: string(BEARER_TOKEN) },
        })
        .willRespondWith({
          status: 404,
          headers: { "Content-Type": "application/json" },
          body: { error: like("Transaction not found") },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.get(
            `${mockServer.url}/api/transactions/txn-not-found`,
            { headers: { Authorization: BEARER_TOKEN }, validateStatus: () => true },
          );
          expect(res.status).toBe(404);
        });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. GET /api/transactions — list transactions (paginated)
  // ───────────────────────────────────────────────────────────────────────────
  describe("GET /api/transactions — list transactions", () => {
    it("returns a paginated list of transactions for the authenticated user", async () => {
      await provider
        .given("the authenticated user has at least one transaction")
        .uponReceiving("a request to list transactions with default pagination")
        .withRequest({
          method: "GET",
          path: "/api/transactions",
          query: { page: "1", limit: "10" },
          headers: { Authorization: string(BEARER_TOKEN) },
        })
        .willRespondWith({
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: {
            data: like([
              {
                id: like("txn-uuid-001"),
                status: like("completed"),
                amount: like(5000),
                currency: like("XAF"),
                created_at: like("2026-06-25T08:00:00.000Z"),
              },
            ]),
            pagination: {
              page: integer(1),
              limit: integer(10),
              total: like(1),
            },
          },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.get(
            `${mockServer.url}/api/transactions`,
            { headers: { Authorization: BEARER_TOKEN }, params: { page: 1, limit: 10 } },
          );
          expect(res.status).toBe(200);
          expect(Array.isArray(res.data.data)).toBe(true);
          expect(res.data.pagination).toBeDefined();
        });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. GET /health — liveness probe
  // ───────────────────────────────────────────────────────────────────────────
  describe("GET /health — API health check", () => {
    it("returns service health status", async () => {
      await provider
        .given("the API is running")
        .uponReceiving("a health check request")
        .withRequest({
          method: "GET",
          path: "/health",
        })
        .willRespondWith({
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: {
            status: like("ok"),
            timestamp: like("2026-06-25T08:00:00.000Z"),
          },
        })
        .executeTest(async (mockServer) => {
          const res = await axios.get(`${mockServer.url}/health`);
          expect(res.status).toBe(200);
          expect(res.data.status).toBe("ok");
        });
    });
  });
});
