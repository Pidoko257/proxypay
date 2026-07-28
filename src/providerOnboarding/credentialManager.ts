/**
 * Provider Credential Manager
 *
 * Issue #187 — Provider Onboarding Workflow, acceptance criterion #3.
 *
 * Stores provider credentials encrypted at rest in PostgreSQL. The
 * cleartext secret material only exists in memory after a successful
 * `readCredentials()` call. AES-256-GCM encryption uses the
 * `deriveKey()` helper from `src/utils/encryption.ts`, which itself
 * derives a per-purpose key from `DB_ENCRYPTION_KEY` via HKDF-SHA-256.
 *
 * Stored format: "<version>:<iv>:<authTag>:<ciphertext>" — same encoding
 * as PII fields, so the existing `decryptField()` core can be reused.
 *
 * Rotation: each successful `upsertCredentials()` bumps `last_rotated_at`
 * which is the source of truth for "key age" audits.
 */

import { pool } from "../config/database";
import {
  decryptAES,
  deriveKey,
  encryptAES,
  serializePayload,
  deserializePayload,
} from "../utils/encryption";
import { env } from "../config/env";
import type {
  ProviderAuthMode,
  ProviderCredentialPayload,
} from "./adapterSpec";

const HKDF_INFO = "provider-credential";

interface ProviderCredentialsRow {
  provider_name: string;
  auth_mode: ProviderAuthMode;
  encrypted_payload: string;
  last_rotated_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface ProviderCredentialsRecord {
  providerName: string;
  authMode: ProviderAuthMode;
  /** Cleartext payload — handle as a secret; never log or serialize. */
  payload: ProviderCredentialPayload;
  lastRotatedAt: string;
  createdAt: string;
  updatedAt: string;
}

function getMasterKey(): Buffer {
  if (!env.DB_ENCRYPTION_KEY) {
    throw new Error(
      "DB_ENCRYPTION_KEY is required for provider credential encryption",
    );
  }
  return deriveKey(env.DB_ENCRYPTION_KEY, HKDF_INFO);
}

function encryptPayload(payload: ProviderCredentialPayload): string {
  const json = JSON.stringify(payload);
  const encrypted = encryptAES(json, getMasterKey());
  // Prefix with "v1:" so future key rotations can co-exist on row read.
  return `v1:${serializePayload(encrypted)}`;
}

function decryptPayload(raw: string): ProviderCredentialPayload {
  if (!raw.startsWith("v1:")) {
    throw new Error(
      "Encrypted provider credential payload has unsupported version prefix",
    );
  }
  const json = decryptAES(deserializePayload(raw.slice(3)), getMasterKey());
  const parsed = JSON.parse(json) as ProviderCredentialPayload;
  return parsed;
}

class CredentialManager {
  /**
   * Insert or replace the credential record for a provider.
   * Bumps `last_rotated_at` to NOW() so the audit trail is exact.
   */
  async upsertCredentials(
    providerName: string,
    authMode: ProviderAuthMode,
    payload: ProviderCredentialPayload,
  ): Promise<ProviderCredentialsRecord> {
    const name = providerName.toLowerCase();
    const encrypted = encryptPayload(payload);

    const result = await pool.query<ProviderCredentialsRow>(
      `INSERT INTO provider_credentials
         (provider_name, auth_mode, encrypted_payload, last_rotated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (provider_name) DO UPDATE SET
         auth_mode         = EXCLUDED.auth_mode,
         encrypted_payload = EXCLUDED.encrypted_payload,
         last_rotated_at   = NOW(),
         updated_at        = NOW()
       RETURNING *
      `,
      [name, authMode, encrypted],
    );

    const row = result.rows[0];
    return this.toRecord(row, payload);
  }

  /**
   * Returns the decrypted credentials for a provider. Returns null when
   * no row exists. The returned `payload` is sensitive — callers must
   * not log it, persist it back to the DB cleartext, or echo it through
   * public APIs.
   */
  async readCredentials(
    providerName: string,
  ): Promise<ProviderCredentialsRecord | null> {
    const result = await pool.query<ProviderCredentialsRow>(
      "SELECT * FROM provider_credentials WHERE provider_name = $1 LIMIT 1",
      [providerName.toLowerCase()],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    const payload = decryptPayload(row.encrypted_payload);
    return this.toRecord(row, payload);
  }

  /** Returns metadata only — no cleartext secrets. Safe for dashboards. */
  async listCredentials(): Promise<
    Array<{
      providerName: string;
      authMode: ProviderAuthMode;
      lastRotatedAt: string;
      ageInDays: number;
      hasApiKey: boolean;
      hasApiSecret: boolean;
      hasSubscriptionKey: boolean;
      hasCallbackSecret: boolean;
    }>
  > {
    const result = await pool.query<{
      provider_name: string;
      auth_mode: ProviderAuthMode;
      last_rotated_at: Date;
      encrypted_payload: string;
    }>(
      "SELECT provider_name, auth_mode, last_rotated_at, encrypted_payload FROM provider_credentials ORDER BY provider_name ASC",
    );
    const now = Date.now();
    return result.rows.map((row) => {
      let hasApiKey = false;
      let hasApiSecret = false;
      let hasSubscriptionKey = false;
      let hasCallbackSecret = false;
      try {
        const p = decryptPayload(row.encrypted_payload);
        hasApiKey = Boolean(p.apiKey);
        hasApiSecret = Boolean(p.apiSecret);
        hasSubscriptionKey = Boolean(p.subscriptionKey);
        hasCallbackSecret = Boolean(p.callbackSecret);
      } catch {
        // Treat as missing fields on decrypt failure.
      }
      const ageMs = now - row.last_rotated_at.getTime();
      return {
        providerName: row.provider_name,
        authMode: row.auth_mode,
        lastRotatedAt: row.last_rotated_at.toISOString(),
        ageInDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
        hasApiKey,
        hasApiSecret,
        hasSubscriptionKey,
        hasCallbackSecret,
      };
    });
  }

  /** Permanently delete a provider's credentials. */
  async deleteCredentials(providerName: string): Promise<boolean> {
    const result = await pool.query(
      "DELETE FROM provider_credentials WHERE provider_name = $1",
      [providerName.toLowerCase()],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private toRecord(
    row: ProviderCredentialsRow,
    payload: ProviderCredentialPayload,
  ): ProviderCredentialsRecord {
    return {
      providerName: row.provider_name,
      authMode: row.auth_mode,
      payload,
      lastRotatedAt: row.last_rotated_at.toISOString(),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }
}

export const credentialManager = new CredentialManager();
