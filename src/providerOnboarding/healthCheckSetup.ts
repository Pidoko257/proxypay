/**
 * Automated Provider Health Check Setup
 *
 * Issue #187 — Provider Onboarding Workflow, acceptance criterion #7.
 *
 * Wires a newly-onboarded provider into the live health-check rotation.
 * The runtime health check (`src/services/mobilemoney/providers/healthCheck.ts`)
 * reads its `DEFAULT_PROVIDERS` constant from the source tree; the
 * goal of this module is to UNION that constant with rows persisted in
 * the `provider_health_configs` table so DB-based onboarding works
 * without redeploys.
 *
 * To prevent unbounded list growth, DB rows are capped at 100 active
 * providers and disabled rows are filtered out at query time.
 */

import { pool } from "../config/database";
import {
  DEFAULT_PROVIDERS,
  ProviderConfig,
  ProviderName,
} from "../services/mobilemoney/providers/healthCheck";

export interface HealthCheckRegistration {
  providerName: string;
  pingUrl: string;
  timeoutMs: number;
}

export interface HealthCheckConfigRow {
  id: string;
  providerName: string;
  pingUrl: string;
  timeoutMs: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

const DB_PROVIDER_LIMIT = 100;

class HealthCheckSetup {
  /**
   * Idempotent registration. Calling this with the same provider twice
   * updates the existing row rather than creating a second one.
   */
  async registerProviderForHealthCheck(
    input: HealthCheckRegistration,
  ): Promise<HealthCheckConfigRow> {
    const name = input.providerName.toLowerCase();

    // Guard the global cap.
    const count = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM provider_health_configs WHERE enabled = TRUE",
    );
    const activeCount = Number(count.rows[0]?.count ?? 0);
    const isUpdate = await pool.query<{ enabled: boolean }>(
      "SELECT enabled FROM provider_health_configs WHERE provider_name = $1",
      [name],
    );
    if (activeCount >= DB_PROVIDER_LIMIT && (isUpdate.rowCount ?? 0) === 0) {
      throw new Error(
        `Cannot register ${name}: ${activeCount} providers are already active (limit ${DB_PROVIDER_LIMIT}). Disable or delete an existing row first.`,
      );
    }

    const result = await pool.query<{
      id: string;
      provider_name: string;
      ping_url: string;
      timeout_ms: number;
      enabled: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `INSERT INTO provider_health_configs
         (provider_name, ping_url, timeout_ms, enabled)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (provider_name) DO UPDATE SET
         ping_url   = EXCLUDED.ping_url,
         timeout_ms = EXCLUDED.timeout_ms,
         enabled    = TRUE,
         updated_at = NOW()
       RETURNING *
      `,
      [name, input.pingUrl, input.timeoutMs],
    );
    const row = result.rows[0];
    return {
      id: row.id,
      providerName: row.provider_name,
      pingUrl: row.ping_url,
      timeoutMs: row.timeout_ms,
      enabled: row.enabled,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async disableProvider(providerName: string): Promise<boolean> {
    const result = await pool.query(
      "UPDATE provider_health_configs SET enabled = FALSE, updated_at = NOW() WHERE provider_name = $1",
      [providerName.toLowerCase()],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listActiveConfigs(): Promise<HealthCheckConfigRow[]> {
    const result = await pool.query<{
      id: string;
      provider_name: string;
      ping_url: string;
      timeout_ms: number;
      enabled: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      "SELECT * FROM provider_health_configs WHERE enabled = TRUE ORDER BY provider_name ASC",
    );
    return result.rows.map((r) => ({
      id: r.id,
      providerName: r.provider_name,
      pingUrl: r.ping_url,
      timeoutMs: r.timeout_ms,
      enabled: r.enabled,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    }));
  }

  /**
   * Returns the runtime ping list — union of DEFAULT_PROVIDERS and the
   * DB-backed rows. Duplicate names honour the DB row (giving operators
   * a way to override the baked-in defaults).
   *
   * Returns `ProviderConfig` so this function can be passed straight
   * into `checkMobileMoneyHealth()`.
   */
  async resolveHealthConfigs(): Promise<ProviderConfig[]> {
    const dbRows = await this.listActiveConfigs();
    const overrideByName = new Map<string, HealthCheckConfigRow>();
    for (const row of dbRows) {
      overrideByName.set(row.providerName as ProviderName, row);
    }

    const merged: ProviderConfig[] = [];
    const seen = new Set<string>();
    for (const def of DEFAULT_PROVIDERS) {
      seen.add(def.name);
      const override = overrideByName.get(def.name);
      merged.push({
        name: def.name,
        pingUrl: override?.pingUrl ?? def.pingUrl,
        timeoutMs: override?.timeoutMs ?? def.timeoutMs,
      });
      if (override) overrideByName.delete(def.name);
    }
    for (const row of overrideByName.values()) {
      if (seen.has(row.providerName)) continue;
      merged.push({
        name: row.providerName as ProviderName,
        pingUrl: row.pingUrl,
        timeoutMs: row.timeoutMs,
      });
    }
    return merged;
  }
}

export const healthCheckSetup = new HealthCheckSetup();
