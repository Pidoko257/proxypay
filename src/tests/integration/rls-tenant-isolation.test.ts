/**
 * Integration tests: PostgreSQL Row-Level Security – cross-tenant isolation
 *
 * These tests spin up the RLS migration against a real Postgres instance
 * (TEST_DATABASE_URL) and verify that data inserted by tenant A is invisible
 * to tenant B on all four tenant-scoped tables:
 *
 *   transactions | api_keys | merchant_webhooks | kyc_documents
 *
 * Each test follows the pattern:
 *   1. Insert a row for org A (with tenant context set)
 *   2. Query the same table with org B's context → expect 0 rows
 *   3. Query with org A's context → expect 1 row
 */

import { Pool, PoolClient } from "pg";
import { v4 as uuidv4 } from "uuid";
import { setTenantContext } from "../../config/database";

// ─── Test database connection ─────────────────────────────────────────────────

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";

let testPool: Pool;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run `fn` inside a transaction scoped to `orgId`.
 * Rolls back when done so tests leave no state behind.
 */
async function withTenant<T>(
  orgId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await testPool.connect();
  try {
    await client.query("BEGIN");
    await setTenantContext(client, orgId);
    return await fn(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** Create an organisation row and return its id. */
async function createOrg(client: PoolClient, name: string): Promise<string> {
  const res = await client.query<{ id: string }>(
    "INSERT INTO organisations (name) VALUES ($1) RETURNING id",
    [name],
  );
  return res.rows[0].id;
}

// ─── Suite setup / teardown ───────────────────────────────────────────────────

beforeAll(async () => {
  if (!TEST_DB_URL) {
    throw new Error(
      "TEST_DATABASE_URL (or DATABASE_URL) must be set to run RLS integration tests",
    );
  }
  testPool = new Pool({ connectionString: TEST_DB_URL });
});

afterAll(async () => {
  await testPool.end();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("RLS cross-tenant isolation", () => {
  /**
   * Shared org IDs – created once in the outer transaction of each test so that
   * every test is fully self-contained and leaves no permanent data.
   */

  // ── transactions ────────────────────────────────────────────────────────────
  describe("transactions table", () => {
    it("hides tenant A rows from tenant B", async () => {
      const rootClient = await testPool.connect();
      let orgA: string;
      let orgB: string;

      try {
        await rootClient.query("BEGIN");

        orgA = await createOrg(rootClient, "Org-A-txn");
        orgB = await createOrg(rootClient, "Org-B-txn");

        // Insert row for org A (no RLS context needed for seed – uses root client)
        await rootClient.query(
          `INSERT INTO transactions
             (reference_number, type, amount, phone_number, provider,
              stellar_address, status, organization_id)
           VALUES ($1,'deposit',1000,'237600000000','mtn',
                   'GTEST','pending',$2)`,
          [`REF-${uuidv4()}`, orgA],
        );

        // Tenant B sees 0 rows
        const fromB = await withTenant(orgB, (c) =>
          c.query("SELECT id FROM transactions WHERE organization_id = $1", [orgA]),
        );
        expect(fromB.rows).toHaveLength(0);

        // Tenant A sees its own row
        const fromA = await withTenant(orgA, (c) =>
          c.query("SELECT id FROM transactions WHERE organization_id = $1", [orgA]),
        );
        expect(fromA.rows).toHaveLength(1);
      } finally {
        await rootClient.query("ROLLBACK");
        rootClient.release();
      }
    });
  });

  // ── api_keys ─────────────────────────────────────────────────────────────────
  describe("api_keys table", () => {
    it("hides tenant A rows from tenant B", async () => {
      const rootClient = await testPool.connect();
      let orgA: string;
      let orgB: string;

      try {
        await rootClient.query("BEGIN");

        orgA = await createOrg(rootClient, "Org-A-keys");
        orgB = await createOrg(rootClient, "Org-B-keys");

        // Seed a user required by FK on api_keys
        const userRes = await rootClient.query<{ id: string }>(
          `INSERT INTO users (phone_number, kyc_level)
           VALUES ($1,'unverified') RETURNING id`,
          [`+237${Date.now()}`],
        );
        const userId = userRes.rows[0].id;

        await rootClient.query(
          `INSERT INTO api_keys (user_id, key, organization_id)
           VALUES ($1, $2, $3)`,
          [userId, `key-${uuidv4()}`, orgA],
        );

        const fromB = await withTenant(orgB, (c) =>
          c.query("SELECT id FROM api_keys WHERE organization_id = $1", [orgA]),
        );
        expect(fromB.rows).toHaveLength(0);

        const fromA = await withTenant(orgA, (c) =>
          c.query("SELECT id FROM api_keys WHERE organization_id = $1", [orgA]),
        );
        expect(fromA.rows).toHaveLength(1);
      } finally {
        await rootClient.query("ROLLBACK");
        rootClient.release();
      }
    });
  });

  // ── merchant_webhooks ────────────────────────────────────────────────────────
  describe("merchant_webhooks table", () => {
    it("hides tenant A rows from tenant B", async () => {
      const rootClient = await testPool.connect();
      let orgA: string;
      let orgB: string;

      try {
        await rootClient.query("BEGIN");

        orgA = await createOrg(rootClient, "Org-A-wh");
        orgB = await createOrg(rootClient, "Org-B-wh");

        const userRes = await rootClient.query<{ id: string }>(
          `INSERT INTO users (phone_number, kyc_level)
           VALUES ($1,'unverified') RETURNING id`,
          [`+237${Date.now() + 1}`],
        );
        const userId = userRes.rows[0].id;

        await rootClient.query(
          `INSERT INTO merchant_webhooks (user_id, url, secret, organization_id)
           VALUES ($1, 'https://example.com/hook', 'secret', $2)`,
          [userId, orgA],
        );

        const fromB = await withTenant(orgB, (c) =>
          c.query("SELECT id FROM merchant_webhooks WHERE organization_id = $1", [orgA]),
        );
        expect(fromB.rows).toHaveLength(0);

        const fromA = await withTenant(orgA, (c) =>
          c.query("SELECT id FROM merchant_webhooks WHERE organization_id = $1", [orgA]),
        );
        expect(fromA.rows).toHaveLength(1);
      } finally {
        await rootClient.query("ROLLBACK");
        rootClient.release();
      }
    });
  });

  // ── kyc_documents ────────────────────────────────────────────────────────────
  describe("kyc_documents table", () => {
    it("hides tenant A rows from tenant B", async () => {
      const rootClient = await testPool.connect();
      let orgA: string;
      let orgB: string;

      try {
        await rootClient.query("BEGIN");

        orgA = await createOrg(rootClient, "Org-A-kyc");
        orgB = await createOrg(rootClient, "Org-B-kyc");

        const userRes = await rootClient.query<{ id: string }>(
          `INSERT INTO users (phone_number, kyc_level)
           VALUES ($1,'unverified') RETURNING id`,
          [`+237${Date.now() + 2}`],
        );
        const userId = userRes.rows[0].id;

        await rootClient.query(
          `INSERT INTO kyc_documents
             (user_id, applicant_id, document_type, file_url, s3_key,
              original_filename, file_size, mime_type, organization_id)
           VALUES ($1,'app-1','passport','https://s3/doc','s3/key',
                   'passport.jpg',12345,'image/jpeg',$2)`,
          [userId, orgA],
        );

        const fromB = await withTenant(orgB, (c) =>
          c.query("SELECT id FROM kyc_documents WHERE organization_id = $1", [orgA]),
        );
        expect(fromB.rows).toHaveLength(0);

        const fromA = await withTenant(orgA, (c) =>
          c.query("SELECT id FROM kyc_documents WHERE organization_id = $1", [orgA]),
        );
        expect(fromA.rows).toHaveLength(1);
      } finally {
        await rootClient.query("ROLLBACK");
        rootClient.release();
      }
    });
  });

  // ── INSERT blocked for wrong tenant ─────────────────────────────────────────
  describe("INSERT enforcement", () => {
    it("rejects INSERT with mismatched organization_id", async () => {
      const rootClient = await testPool.connect();

      try {
        await rootClient.query("BEGIN");

        const orgA = await createOrg(rootClient, "Org-A-insert");
        const orgB = await createOrg(rootClient, "Org-B-insert");

        // Tenant A's context must not be able to insert a row tagged with org B
        await expect(
          withTenant(orgA, (c) =>
            c.query(
              `INSERT INTO transactions
                 (reference_number, type, amount, phone_number, provider,
                  stellar_address, status, organization_id)
               VALUES ($1,'deposit',500,'237600000001','mtn',
                       'GTEST2','pending',$2)`,
              [`REF-${uuidv4()}`, orgB], // org_id does NOT match tenant context
            ),
          ),
        ).rejects.toThrow();
      } finally {
        await rootClient.query("ROLLBACK");
        rootClient.release();
      }
    });
  });
});
