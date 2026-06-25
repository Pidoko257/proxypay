/**
 * Pact Provider Verification — ProxyPay API
 *
 * Verifies that the ProxyPay backend satisfies every interaction defined
 * in the proxypay-frontend consumer pact.
 *
 * Run after consumer pacts have been published to the Pact Broker, or
 * locally against the pacts/ directory.
 */
import path from "path";
import { Verifier } from "@pact-foundation/pact";
import app from "../../src/index";
import { Server } from "http";
import { TransactionModel, TransactionStatus } from "../../src/models/transaction";
import { pool } from "../../src/config/database";

const PACT_BROKER_URL = process.env.PACT_BROKER_URL;
const PACT_BROKER_TOKEN = process.env.PACT_BROKER_TOKEN;
const CONSUMER_VERSION_SELECTORS = [{ mainBranch: true }, { deployedOrReleased: true }];

// Use broker when configured, otherwise fall back to local pact files
const pactSource = PACT_BROKER_URL
  ? {
      pactBrokerUrl: PACT_BROKER_URL,
      pactBrokerToken: PACT_BROKER_TOKEN,
      consumerVersionSelectors: CONSUMER_VERSION_SELECTORS,
      enablePending: true,
    }
  : {
      pactUrls: [
        path.resolve(
          __dirname,
          "../../pacts/proxypay-frontend-ProxyPayAPI.json",
        ),
      ],
    };

describe("ProxyPay API — Pact Provider Verification", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        port = (server.address() as any).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await pool.end().catch(() => {});
  });

  it("validates all consumer pact interactions", async () => {
    const opts = {
      provider: "ProxyPayAPI",
      providerBaseUrl: `http://127.0.0.1:${port}`,

      // ── Pact source ─────────────────────────────────────────────────────
      ...pactSource,

      // ── Provider states ─────────────────────────────────────────────────
      // Each state matches a `given(...)` string in the consumer pact tests.
      stateHandlers: {
        "the API is running": async () => {
          // no-op — server is always running in this test
        },

        "a registered user exists with phone +237670000001": async () => {
          // Seed is handled via JWT stub; no DB write needed in unit verification
        },

        "no user exists with phone +237670000099": async () => {
          // Ensure no record — typically a no-op in an empty test DB
        },

        "an authenticated user with sufficient mobile money balance": async () => {
          // JWT auth is bypassed via the token stub in the auth header check
        },

        [`a completed deposit transaction with id txn-uuid-001`]: async () => {
          // Insert a stub transaction so GET /api/transactions/txn-uuid-001 returns 200
          await pool
            .query(
              `INSERT INTO transactions (id, status, amount, currency, provider, stellar_tx_hash, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
               ON CONFLICT (id) DO NOTHING`,
              [
                "txn-uuid-001",
                TransactionStatus.Completed,
                5000,
                "XAF",
                "mtn",
                "abc123def456",
              ],
            )
            .catch(() => {}); // ignore if table/columns differ in test env
        },

        "no transaction exists with id txn-not-found": async () => {
          await pool
            .query(`DELETE FROM transactions WHERE id = $1`, ["txn-not-found"])
            .catch(() => {});
        },

        "the authenticated user has at least one transaction": async () => {
          await pool
            .query(
              `INSERT INTO transactions (id, status, amount, currency, provider, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
               ON CONFLICT (id) DO NOTHING`,
              ["txn-uuid-001", TransactionStatus.Completed, 5000, "XAF", "mtn"],
            )
            .catch(() => {});
        },
      },

      // ── Request filter — inject auth bypass ─────────────────────────────
      // The consumer sends `Bearer test-jwt-token`; this filter replaces it
      // with a valid signed token so the auth middleware doesn't reject it.
      requestFilter: (req: any, _res: any, next: any) => {
        if (req.headers.authorization?.startsWith("Bearer ")) {
          // Swap the placeholder token for a real one generated with the
          // test JWT_SECRET so the middleware accepts it.
          const jwt = require("jsonwebtoken");
          const testToken = jwt.sign(
            { id: "user-uuid-001", phone_number: "+237670000001", role: "user" },
            process.env.JWT_SECRET || "test-jwt-secret",
            { expiresIn: "1h" },
          );
          req.headers.authorization = `Bearer ${testToken}`;
        }
        next();
      },

      publishVerificationResult: !!(PACT_BROKER_URL && process.env.CI),
      providerVersion: process.env.GITHUB_SHA || "local",
      providerVersionBranch: process.env.GITHUB_REF_NAME || "local",

      logLevel: "warn" as const,
    };

    await new Verifier(opts).verifyProvider();
  }, 60_000);
});
