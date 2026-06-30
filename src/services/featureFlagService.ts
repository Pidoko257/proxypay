import { pool } from "../config/database";
import { redisClient } from "../config/redis";

export const FEATURE_FLAG_CACHE_PREFIX = "feature_flag";
export const FEATURE_FLAG_CACHE_TTL = 60;

export interface FeatureFlag {
  id: string;
  organizationId: string;
  flagName: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function cacheKey(orgId: string, flagName: string): string {
  return `${FEATURE_FLAG_CACHE_PREFIX}:${orgId}:${flagName}`;
}

export async function getFeatureFlag(
  organizationId: string,
  flagName: string,
): Promise<boolean> {
  const key = cacheKey(organizationId, flagName);

  if (redisClient?.isOpen) {
    try {
      const raw = await redisClient.get(key);
      if (raw !== null) {
        return raw === "1";
      }
    } catch (err) {
      console.warn("[feature-flags] Cache read failed", err);
    }
  }

  try {
    const result = await pool.query(
      `SELECT enabled FROM feature_flags
       WHERE organization_id = $1 AND flag_name = $2
       LIMIT 1`,
      [organizationId, flagName],
    );

    const enabled = result.rows.length > 0 ? result.rows[0].enabled : false;

    if (redisClient?.isOpen) {
      try {
        await redisClient.setEx(key, FEATURE_FLAG_CACHE_TTL, enabled ? "1" : "0");
      } catch (err) {
        console.warn("[feature-flags] Cache write failed", err);
      }
    }

    return enabled;
  } catch (err) {
    console.error("[feature-flags] Database query failed", err);
    return false;
  }
}

export async function setFeatureFlag(
  organizationId: string,
  flagName: string,
  enabled: boolean,
): Promise<void> {
  const key = cacheKey(organizationId, flagName);

  try {
    await pool.query(
      `INSERT INTO feature_flags (organization_id, flag_name, enabled)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, flag_name)
       DO UPDATE SET enabled = $3`,
      [organizationId, flagName, enabled],
    );

    if (redisClient?.isOpen) {
      try {
        await redisClient.setEx(key, FEATURE_FLAG_CACHE_TTL, enabled ? "1" : "0");
      } catch (err) {
        console.warn("[feature-flags] Cache write failed", err);
      }
    }

    console.log(
      `[feature-flags] Set flag "${flagName}" for org ${organizationId} to ${enabled}`,
    );
  } catch (err) {
    console.error("[feature-flags] Failed to set flag", err);
    throw err;
  }
}

export async function deleteFeatureFlag(
  organizationId: string,
  flagName: string,
): Promise<void> {
  const key = cacheKey(organizationId, flagName);

  try {
    await pool.query(
      `DELETE FROM feature_flags
       WHERE organization_id = $1 AND flag_name = $2`,
      [organizationId, flagName],
    );

    if (redisClient?.isOpen) {
      try {
        await redisClient.del(key);
      } catch (err) {
        console.warn("[feature-flags] Cache delete failed", err);
      }
    }

    console.log(
      `[feature-flags] Deleted flag "${flagName}" for org ${organizationId}`,
    );
  } catch (err) {
    console.error("[feature-flags] Failed to delete flag", err);
    throw err;
  }
}

export async function getAllFeatureFlags(
  organizationId: string,
): Promise<FeatureFlag[]> {
  try {
    const result = await pool.query(
      `SELECT id, organization_id, flag_name, enabled, created_at, updated_at
       FROM feature_flags
       WHERE organization_id = $1
       ORDER BY flag_name`,
      [organizationId],
    );

    return result.rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      flagName: row.flag_name,
      enabled: row.enabled,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  } catch (err) {
    console.error("[feature-flags] Failed to list flags", err);
    throw err;
  }
}
