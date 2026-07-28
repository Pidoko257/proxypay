import { queryRead } from "../config/database";
import {
  ApiKeyScopeName,
  CreateApiKeyOptions,
  createApiKey,
} from "../auth/apikeys";
import { AuditContext } from "../middleware/auditContext";
import { withAuditTransaction } from "./auditTransaction";

export interface ApiKeyListItem {
  id: string;
  key_prefix: string;
  label?: string | null;
  permissions: number;
  scopes: ApiKeyScopeName[];
  created_at: Date;
  expires_at: Date;
  is_active: boolean;
}

export interface CreatedApiKey {
  id: string;
  api_key: string;
  label?: string | null;
  permissions: number;
  scopes: ApiKeyScopeName[];
  created_at: Date;
  expires_at: Date;
}

export class ApiKeyService {
  async createForUser(
    userId: string,
    options: CreateApiKeyOptions,
    context: AuditContext,
  ): Promise<CreatedApiKey> {
    const key = createApiKey({ apiKeys: [] }, options);
    return withAuditTransaction(context, async (client) => {
      const result = await client.query<CreatedApiKey>(
        `INSERT INTO api_keys
           (user_id, key, permissions, scopes, label, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, user_id, label, permissions, scopes, created_at, expires_at`,
        [
          userId,
          key.key,
          key.permissions,
          key.scopes,
          key.label ?? null,
          key.expiresAt,
        ],
      );

      const row = result.rows[0];
      if (!row) {
        throw new Error("API key creation did not return a database row");
      }

      return {
        value: {
          ...row,
          api_key: key.key,
          scopes: row.scopes ?? key.scopes,
        },
        audit: {
          action: "api_key.create",
          entityType: "api_key",
          entityId: row.id,
          beforeState: null,
          afterState: {
            id: row.id,
            userId,
            label: row.label,
            permissions: row.permissions,
            scopes: row.scopes,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
          },
        },
      };
    });
  }

  async revokeForUser(
    userId: string,
    keyId: string,
    context: AuditContext,
  ): Promise<void> {
    return withAuditTransaction(context, async (client) => {
      const currentResult = await client.query(
        `SELECT id, user_id, label, permissions, scopes, created_at, expires_at,
                is_active, revoked_at
           FROM api_keys
          WHERE id = $1 AND user_id = $2
          FOR UPDATE`,
        [keyId, userId],
      );
      const before = currentResult.rows[0];
      if (!before) throw new Error("API key not found");

      const result = await client.query(
        `UPDATE api_keys
            SET is_active = FALSE, revoked_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND user_id = $2 AND is_active = TRUE
          RETURNING id, user_id, label, permissions, scopes, created_at,
                    expires_at, is_active, revoked_at`,
        [keyId, userId],
      );
      const after = result.rows[0];
      if (!after) throw new Error("API key is already revoked");

      return {
        value: undefined,
        audit: {
          action: "api_key.revoke",
          entityType: "api_key",
          entityId: keyId,
          beforeState: before,
          afterState: after,
        },
      };
    });
  }

  async listForUser(userId: string): Promise<ApiKeyListItem[]> {
    const result = await queryRead<ApiKeyListItem>(
      `SELECT id,
              LEFT(key, 8) AS key_prefix,
              label,
              permissions,
              scopes,
              created_at,
              expires_at,
              is_active
         FROM api_keys
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [userId],
    );

    return result.rows;
  }
}

export const apiKeyService = new ApiKeyService();
