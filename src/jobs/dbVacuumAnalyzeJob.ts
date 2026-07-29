import { pool } from "../config/database";
import {
  APP_MAINTENANCE_MODE,
  env,
} from "../config/env";

export interface VacuumAnalyzeResult {
  tablename: string;
  durationMs: number;
  status: "success" | "skipped" | "failed";
  error?: string;
}

/**
 * Helper to safely sanitize and quote double quotes in identifier names
 */
function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Verify if database is primary (not in recovery mode)
 */
async function isPrimaryDatabase(): Promise<boolean> {
  const result = await pool.query<{ pg_is_in_recovery: boolean }>(
    "SELECT pg_is_in_recovery() AS pg_is_in_recovery",
  );
  return !result.rows[0]?.pg_is_in_recovery;
}

/**
 * Count active database connections during off-peak hours
 */
async function getActiveConnectionCount(): Promise<number> {
  const result = await pool.query<{ active_connections: string }>(
    `SELECT count(*) AS active_connections
     FROM pg_stat_activity
     WHERE datname = current_database()
       AND state = 'active'
       AND pid <> pg_backend_pid()`,
  );
  return parseInt(result.rows[0]?.active_connections || "0", 10);
}

/**
 * Fetch all user-defined tables in public schema for VACUUM and ANALYZE
 */
async function getUserTables(): Promise<string[]> {
  const query = `
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename ASC;
  `;
  const result = await pool.query<{ tablename: string }>(query);
  return result.rows.map((row) => row.tablename);
}

/**
 * Run automatic VACUUM and ANALYZE scheduling during off-peak hours
 * Optimizes PostgreSQL vacuum settings to reduce bloat and improve query plan stability
 */
export async function runDbVacuumAnalyzeJob(): Promise<VacuumAnalyzeResult[]> {
  console.info("[vacuum-analyze] Starting automated VACUUM and ANALYZE job");
  const results: VacuumAnalyzeResult[] = [];

  if (!env.VACUUM_ANALYZE_JOB_ENABLED) {
    console.info("[vacuum-analyze] Skipping because VACUUM_ANALYZE_JOB_ENABLED is false");
    return results;
  }

  if (APP_MAINTENANCE_MODE) {
    console.info("[vacuum-analyze] Skipping because application is in maintenance mode");
    return results;
  }

  try {
    if (!(await isPrimaryDatabase())) {
      console.info("[vacuum-analyze] Skipping because database is a replica");
      return results;
    }

    const activeConnections = await getActiveConnectionCount();
    if (activeConnections > env.VACUUM_ANALYZE_MAX_CONNECTIONS) {
      console.warn(
        `[vacuum-analyze] Skipping off-peak maintenance due to high active load (${activeConnections} active connections > limit ${env.VACUUM_ANALYZE_MAX_CONNECTIONS})`
      );
      return results;
    }

    const tables = await getUserTables();
    console.info(`[vacuum-analyze] Found ${tables.length} tables to process`);

    for (const table of tables) {
      const startTime = Date.now();
      try {
        const quotedTable = quoteIdentifier(table);
        // Execute VACUUM (ANALYZE) on individual table to optimize query statistics and clear bloat
        await pool.query(`VACUUM (ANALYZE) public.${quotedTable};`);
        const durationMs = Date.now() - startTime;
        console.info(`[vacuum-analyze] Table public.${table} successfully vacuumed & analyzed in ${durationMs}ms`);
        results.push({
          tablename: table,
          durationMs,
          status: "success",
        });
      } catch (err: any) {
        const durationMs = Date.now() - startTime;
        console.error(`[vacuum-analyze] Failed to vacuum & analyze public.${table}:`, err?.message || err);
        results.push({
          tablename: table,
          durationMs,
          status: "failed",
          error: err?.message || String(err),
        });
      }
    }

    console.info("[vacuum-analyze] Off-peak VACUUM and ANALYZE job completed successfully");
    return results;
  } catch (error: any) {
    console.error("[vacuum-analyze] Fatal error in VACUUM and ANALYZE job:", error?.message || error);
    throw error;
  }
}
