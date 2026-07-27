import { pool } from "../config/database";
import { queryRead, queryWrite } from "../config/database";
import { getConfiguredPaymentAsset } from "../services/stellar/assetService";

export interface AssetPreference {
  id: string;
  userId: string;
  assetCode: string;
  issuerPublicKey: string;
  isPreferred: boolean;
  isActiveForSettlement: boolean;
  dailyLimitXaf: number;
  minAmountXaf: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssetInfo {
  assetCode: string;
  issuerPublicKey: string;
  name: string;
  isNative: boolean;
  dailyLimitXaf: number;
  minAmountXaf: number;
}

export interface CreateAssetPreferenceInput {
  assetCode: string;
  issuerPublicKey: string;
  isPreferred?: boolean;
  isActiveForSettlement?: boolean;
  dailyLimitXaf?: number;
  minAmountXaf?: number;
  metadata?: Record<string, unknown>;
}

export class AssetCustomizationService {
  async listUserPreferences(userId: string): Promise<AssetPreference[]> {
    const query = `
      SELECT
        id,
        user_id AS "userId",
        asset_code AS "assetCode",
        issuer_public_key AS "issuerPublicKey",
        is_preferred AS "isPreferred",
        is_active_for_settlement AS "isActiveForSettlement",
        daily_limit_xaf AS "dailyLimitXaf",
        min_amount_xaf AS "minAmountXaf",
        metadata,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM user_asset_preferences
      WHERE user_id = $1
      ORDER BY is_preferred DESC, created_at DESC
    `;

    const result = await queryRead(query, [userId]);
    return result.rows.map(this.mapRow);
  }

  async getUserPreferredAsset(userId: string): Promise<AssetPreference | null> {
    const query = `
      SELECT
        id,
        user_id AS "userId",
        asset_code AS "assetCode",
        issuer_public_key AS "issuerPublicKey",
        is_preferred AS "isPreferred",
        is_active_for_settlement AS "isActiveForSettlement",
        daily_limit_xaf AS "dailyLimitXaf",
        min_amount_xaf AS "minAmountXaf",
        metadata,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM user_asset_preferences
      WHERE user_id = $1 AND is_preferred = true
      LIMIT 1
    `;

    const result = await queryRead(query, [userId]);
    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]);
  }

  async upsertPreference(
    userId: string,
    input: CreateAssetPreferenceInput,
  ): Promise<AssetPreference> {
    const query = `
      INSERT INTO user_asset_preferences (
        user_id,
        asset_code,
        issuer_public_key,
        is_preferred,
        is_active_for_settlement,
        daily_limit_xaf,
        min_amount_xaf,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (user_id, asset_code, issuer_public_key)
      DO UPDATE SET
        is_preferred = EXCLUDED.is_preferred,
        is_active_for_settlement = EXCLUDED.is_active_for_settlement,
        daily_limit_xaf = EXCLUDED.daily_limit_xaf,
        min_amount_xaf = EXCLUDED.min_amount_xaf,
        metadata = EXCLUDED.metadata,
        updated_at = CURRENT_TIMESTAMP
      RETURNING
        id,
        user_id AS "userId",
        asset_code AS "assetCode",
        issuer_public_key AS "issuerPublicKey",
        is_preferred AS "isPreferred",
        is_active_for_settlement AS "isActiveForSettlement",
        daily_limit_xaf AS "dailyLimitXaf",
        min_amount_xaf AS "minAmountXaf",
        metadata,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `;

    const result = await queryRead(query, [
      userId,
      input.assetCode.trim().toUpperCase(),
      input.issuerPublicKey.trim(),
      input.isPreferred ?? false,
      input.isActiveForSettlement ?? true,
      input.dailyLimitXaf ?? 500000,
      input.minAmountXaf ?? 100,
      input.metadata ?? {},
    ]);

    return this.mapRow(result.rows[0]);
  }

  async deletePreference(userId: string, preferenceId: string): Promise<void> {
    const query = `
      DELETE FROM user_asset_preferences
      WHERE id = $1 AND user_id = $2
    `;

    await queryWrite(query, [preferenceId, userId]);
  }

  async setPreferredAsset(userId: string, preferenceId: string): Promise<AssetPreference> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        'UPDATE user_asset_preferences SET is_preferred = false WHERE user_id = $1',
        [userId],
      );

      const result = await client.query(
        `
        UPDATE user_asset_preferences
        SET is_preferred = true, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND user_id = $2
        RETURNING
          id,
          user_id AS "userId",
          asset_code AS "assetCode",
          issuer_public_key AS "issuerPublicKey",
          is_preferred AS "isPreferred",
          is_active_for_settlement AS "isActiveForSettlement",
          daily_limit_xaf AS "dailyLimitXaf",
          min_amount_xaf AS "minAmountXaf",
          metadata,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        `,
        [preferenceId, userId],
      );

      await client.query("COMMIT");

      if (result.rows.length === 0) {
        throw new Error("Asset preference not found");
      }

      return this.mapRow(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getAvailableAssets(): Promise<AssetInfo[]> {
    const query = `
      SELECT
        asset_code AS "assetCode",
        issuer_public_key AS "issuerPublicKey",
        COALESCE(metadata->>'name', asset_code) AS name,
        false AS "isNative",
        COALESCE((metadata->>'daily_limit_xaf')::numeric, 500000) AS "dailyLimitXaf",
        COALESCE((metadata->>'min_amount_xaf')::numeric, 100) AS "minAmountXaf"
      FROM anchored_assets
      WHERE status = 'active'
      ORDER BY asset_code
    `;

    const result = await queryRead(query);
    const assets = result.rows.map((row) => ({
      assetCode: row.assetCode,
      issuerPublicKey: row.issuerPublicKey,
      name: row.name,
      isNative: false,
      dailyLimitXaf: Number(row.dailyLimitXaf),
      minAmountXaf: Number(row.minAmountXaf),
    }));

    const nativeAsset = getConfiguredPaymentAsset();
    if (nativeAsset.isNative()) {
      assets.unshift({
        assetCode: "XLM",
        issuerPublicKey: "native",
        name: "Stellar Lumens (XLM)",
        isNative: true,
        dailyLimitXaf: 500000,
        minAmountXaf: 100,
      });
    }

    return assets;
  }

  async getUserSettlementAsset(userId: string): Promise<AssetInfo | null> {
    const pref = await this.getUserPreferredAsset(userId);
    if (!pref) {
      const nativeAsset = getConfiguredPaymentAsset();
      if (nativeAsset.isNative()) {
        return {
          assetCode: "XLM",
          issuerPublicKey: "native",
          name: "Stellar Lumens (XLM)",
          isNative: true,
          dailyLimitXaf: 500000,
          minAmountXaf: 100,
        };
      }
      return null;
    }

    return {
      assetCode: pref.assetCode,
      issuerPublicKey: pref.issuerPublicKey,
      name: pref.metadata?.name as string || pref.assetCode,
      isNative: pref.issuerPublicKey === "native",
      dailyLimitXaf: pref.dailyLimitXaf,
      minAmountXaf: pref.minAmountXaf,
    };
  }

  private mapRow(row: Record<string, unknown>): AssetPreference {
    return {
      id: row.id as string,
      userId: row.userId as string,
      assetCode: row.assetCode as string,
      issuerPublicKey: row.issuerPublicKey as string,
      isPreferred: row.isPreferred as boolean,
      isActiveForSettlement: row.isActiveForSettlement as boolean,
      dailyLimitXaf: Number(row.dailyLimitXaf),
      minAmountXaf: Number(row.minAmountXaf),
      metadata: (row.metadata as Record<string, unknown>) || {},
      createdAt: new Date(row.createdAt as Date),
      updatedAt: new Date(row.updatedAt as Date),
    };
  }
}

export const assetCustomizationService = new AssetCustomizationService();
