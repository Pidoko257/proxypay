import { queryRead, queryWrite } from "../config/database";
import {
  ApiKeyScopeName,
  CreateApiKeyOptions,
  createApiKey,
} from "../auth/apikeys";

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
  ): Promise<CreatedApiKey> {
    const key = createApiKey({ apiKeys: [] }, options);
    const result = await queryWrite<CreatedApiKey>(
      `INSERT INTO api_keys
         (user_id, key, permissions, scopes, label, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, label, permissions, scopes, created_at, expires_at`,
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
      ...row,
      api_key: key.key,
      scopes: row.scopes ?? key.scopes,
    };
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
