#!/usr/bin/env tsx
/**
 * ProxyPay development seed script.
 * Run with: npm run db:seed
 *
 * Idempotent — uses ON CONFLICT DO NOTHING / DO UPDATE so it is safe
 * to run multiple times.  All records are prefixed with "TEST_" so they
 * are easy to identify and clean up.
 *
 * What gets created
 *   • 3 test organisations (merchants)
 *   • 2 KYC-approved users
 *   • 5 API keys
 *   • 50 transactions across all status / provider / type combinations
 *   • 3 webhooks
 */

import dotenv from "dotenv";
import { Pool } from "pg";
import crypto from "crypto";

dotenv.config();

if (process.env.NODE_ENV === "production") {
  console.error("Seeding is not allowed in production.");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── helpers ───────────────────────────────────────────────────────────────────

function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

/** Stellar-like address: G + 55 uppercase alphanumeric chars */
function stellarAddress(n: number) {
  return `G${String(n).padStart(5, "0")}TESTSEEDADDR${"X".repeat(38)}`.slice(0, 56);
}

// ── organisations ─────────────────────────────────────────────────────────────

const ORGS = [
  {
    name: "TEST_Org_Alpha",
    email: "test_alpha@proxypay.test",
    phone: "+237600000001",
    business_name: "TEST Alpha Payments Ltd",
    country: "CM",
    status: "active",
    kyc_status: "verified",
  },
  {
    name: "TEST_Org_Beta",
    email: "test_beta@proxypay.test",
    phone: "+237600000002",
    business_name: "TEST Beta Remittance Inc",
    country: "KE",
    status: "active",
    kyc_status: "verified",
  },
  {
    name: "TEST_Org_Gamma",
    email: "test_gamma@proxypay.test",
    phone: "+237600000003",
    business_name: "TEST Gamma Fintech SARL",
    country: "SN",
    status: "pending",
    kyc_status: "in_progress",
  },
];

// ── KYC-approved users ────────────────────────────────────────────────────────

const USERS = [
  { phone: "+237611000001", kyc: "full" },
  { phone: "+237611000002", kyc: "full" },
];

// ── transaction data ──────────────────────────────────────────────────────────

const PROVIDERS = ["mtn", "airtel", "orange"];
const TYPES = ["deposit", "withdraw"] as const;
const STATUSES = [
  ...Array(20).fill("completed"),
  ...Array(15).fill("pending"),
  ...Array(10).fill("failed"),
  ...Array(5).fill("cancelled"),
] as string[];

// ── seed ──────────────────────────────────────────────────────────────────────

async function seed() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Organisations (merchants)
    console.log("Seeding organisations…");
    for (const org of ORGS) {
      await client.query(
        `INSERT INTO merchants
           (name, email, phone_number, business_name, country, status, kyc_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (email) DO UPDATE
           SET name          = EXCLUDED.name,
               status        = EXCLUDED.status,
               kyc_status    = EXCLUDED.kyc_status,
               updated_at    = CURRENT_TIMESTAMP`,
        [org.name, org.email, org.phone, org.business_name, org.country, org.status, org.kyc_status],
      );
    }

    // 2. Users
    console.log("Seeding users…");
    const userIds: string[] = [];
    for (const u of USERS) {
      const { rows } = await client.query(
        `INSERT INTO users (phone_number, kyc_level)
         VALUES ($1,$2)
         ON CONFLICT (phone_number) DO UPDATE SET kyc_level = EXCLUDED.kyc_level
         RETURNING id`,
        [u.phone, u.kyc],
      );
      userIds.push(rows[0].id);
    }

    // 3. API keys (insert-or-ignore — key column must be unique)
    console.log("Seeding API keys…");
    const apiKeyDefs = [
      { label: "TEST_FullAccess_Key",    permissions: 15,   expires_days: 90 },
      { label: "TEST_ReadOnly_Key",      permissions: 1,    expires_days: 90 },
      { label: "TEST_DepositOnly_Key",   permissions: 0x82, expires_days: 30 },
      { label: "TEST_WebhookAdmin_Key",  permissions: 0x6001, expires_days: 30 },
      { label: "TEST_Reporting_Key",     permissions: 0x10001, expires_days: 60 },
    ];
    for (const k of apiKeyDefs) {
      const key = `pp_test_${randomHex(20)}`;
      const expiresAt = new Date(Date.now() + k.expires_days * 86_400_000);
      await client.query(
        `INSERT INTO api_keys (key, label, permissions, scopes, is_active, expires_at)
         VALUES ($1,$2,$3,$4,TRUE,$5)
         ON CONFLICT (key) DO NOTHING`,
        [key, k.label, k.permissions, `{TEST}`, expiresAt],
      );
    }

    // 4. Transactions (50)
    console.log("Seeding 50 transactions…");
    for (let i = 0; i < 50; i++) {
      const status  = STATUSES[i % STATUSES.length];
      const type    = TYPES[i % TYPES.length];
      const provider = PROVIDERS[i % PROVIDERS.length];
      const userId  = userIds[i % userIds.length];
      const ref     = `TEST-${String(i + 1).padStart(4, "0")}-${provider.toUpperCase()}`;
      const amount  = 500 + (i * 197) % 9500;          // deterministic, 500-10000
      const phone   = USERS[i % USERS.length].phone;
      const stellar = stellarAddress(i + 1);

      await client.query(
        `INSERT INTO transactions
           (reference_number, type, amount, phone_number, provider,
            stellar_address, status, user_id, tags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (reference_number) DO UPDATE
           SET status = EXCLUDED.status, updated_at = CURRENT_TIMESTAMP`,
        [ref, type, amount, phone, provider, stellar, status, userId, ["test", "seed"]],
      );
    }

    // 5. Webhooks
    console.log("Seeding webhooks…");
    const webhookDefs = [
      {
        url: "https://test-webhook.proxypay.test/events",
        desc: "TEST_Primary webhook endpoint",
        events: ["transaction.completed", "transaction.failed"],
      },
      {
        url: "https://test-webhook-backup.proxypay.test/events",
        desc: "TEST_Backup webhook endpoint",
        events: ["transaction.completed"],
      },
      {
        url: "https://test-webhook-all.proxypay.test/events",
        desc: "TEST_All-events webhook endpoint",
        events: ["transaction.completed", "transaction.failed"],
      },
    ];
    for (const wh of webhookDefs) {
      const userId = userIds[0];
      const secret = `test_whsec_${randomHex(16)}`;
      // Idempotent: skip if a webhook with the same url+user already exists
      await client.query(
        `INSERT INTO merchant_webhooks (user_id, url, secret, description, events, is_active)
         SELECT $1,$2,$3,$4,$5,TRUE
         WHERE NOT EXISTS (
           SELECT 1 FROM merchant_webhooks WHERE user_id=$1 AND url=$2
         )`,
        [userId, wh.url, secret, wh.desc, wh.events],
      );
    }

    await client.query("COMMIT");
    console.log("✅ Seed complete.");
    console.log(`   Organisations : ${ORGS.length}`);
    console.log(`   Users         : ${USERS.length}`);
    console.log(`   API keys      : ${apiKeyDefs.length}`);
    console.log(`   Transactions  : 50`);
    console.log(`   Webhooks      : ${webhookDefs.length}`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Seed failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
