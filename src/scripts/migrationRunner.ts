/**
 * Database migration runner with version tracking, locking, and dry-run support
 * Handles both SQL and code-based migrations with automatic rollback capability
 */

import fs from "fs";
import path from "path";
import { pool } from "../config/database";
import { redisClient } from "../config/redis";
import { logger } from "../utils/logger";

interface MigrationFile {
  name: string;
  path: string;
  version: string; // timestamp or semver
  type: "sql" | "code";
  timestamp: number;
}

interface MigrationRecord {
  id: string;
  name: string;
  version: string;
  applied_at: Date;
  rolled_back_at: Date | null;
  duration_ms: number;
  status: "applied" | "failed" | "rolled_back";
}

interface MigrationOptions {
  dryRun?: boolean;
  verbose?: boolean;
  target?: string; // Migrate to specific version
}

const MIGRATIONS_DIR = path.join(__dirname, "../../migrations");
const MIGRATION_LOCK_KEY = "migration:lock";
const MIGRATION_LOCK_TTL = 300; // 5 minutes
const MIGRATION_TABLE = "migrations_run";

/**
 * Initialize migration tracking table if it doesn't exist
 */
export async function initializeMigrationTable(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        version VARCHAR(50) NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        rolled_back_at TIMESTAMP,
        duration_ms INTEGER,
        status VARCHAR(20) DEFAULT 'applied',
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_migrations_version (version),
        INDEX idx_migrations_status (status),
        INDEX idx_migrations_applied_at (applied_at)
      )
    `);

    logger.info("Migration tracking table initialized");
  } finally {
    client.release();
  }
}

/**
 * Acquire distributed lock for migrations
 */
export async function acquireMigrationLock(
  timeout: number = 30000,
): Promise<string | null> {
  const lockId = `lock:${Date.now()}:${Math.random()}`;

  try {
    const locked = await redisClient.set(
      MIGRATION_LOCK_KEY,
      lockId,
      "EX",
      Math.ceil(MIGRATION_LOCK_TTL),
      "NX",
    );

    if (locked) {
      logger.info("Migration lock acquired", { lockId });
      return lockId;
    }

    // Wait and retry if lock already exists
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const retryLocked = await redisClient.set(
        MIGRATION_LOCK_KEY,
        lockId,
        "EX",
        Math.ceil(MIGRATION_LOCK_TTL),
        "NX",
      );

      if (retryLocked) {
        return lockId;
      }
    }

    logger.warn("Failed to acquire migration lock within timeout");
    return null;
  } catch (error) {
    logger.error("Failed to acquire migration lock", { error: String(error) });
    return null;
  }
}

/**
 * Release distributed lock
 */
export async function releaseMigrationLock(lockId: string): Promise<void> {
  try {
    const currentLock = await redisClient.get(MIGRATION_LOCK_KEY);
    if (currentLock === lockId) {
      await redisClient.del(MIGRATION_LOCK_KEY);
      logger.info("Migration lock released", { lockId });
    }
  } catch (error) {
    logger.error("Failed to release migration lock", { error: String(error) });
  }
}

/**
 * Discover migration files in migrations directory
 */
export function discoverMigrations(): MigrationFile[] {
  const files = fs.readdirSync(MIGRATIONS_DIR);
  const migrations: MigrationFile[] = [];

  for (const file of files) {
    if (!file.endsWith(".sql")) continue;

    const filePath = path.join(MIGRATIONS_DIR, file);
    const stats = fs.statSync(filePath);

    // Extract version from filename (e.g., "20260327_create_users.sql")
    const versionMatch = file.match(/^(\d{8})/);
    const version = versionMatch ? versionMatch[1] : file;

    migrations.push({
      name: file.replace(".sql", ""),
      path: filePath,
      version,
      type: "sql",
      timestamp: stats.mtimeMs,
    });
  }

  // Sort by version
  return migrations.sort((a, b) => a.version.localeCompare(b.version));
}

/**
 * Get list of applied migrations
 */
export async function getAppliedMigrations(): Promise<MigrationRecord[]> {
  const client = await pool.connect();
  try {
    const result = await client.query<MigrationRecord>(
      `SELECT * FROM ${MIGRATION_TABLE} WHERE status = 'applied' ORDER BY applied_at ASC`,
    );
    return result.rows;
  } finally {
    client.release();
  }
}

/**
 * Get pending migrations
 */
export async function getPendingMigrations(): Promise<MigrationFile[]> {
  const allMigrations = discoverMigrations();
  const applied = await getAppliedMigrations();
  const appliedNames = new Set(applied.map((m) => m.name));

  return allMigrations.filter((m) => !appliedNames.has(m.name));
}

/**
 * Apply a single migration
 */
export async function applyMigration(
  migration: MigrationFile,
  options: MigrationOptions = {},
): Promise<void> {
  const client = await pool.connect();
  const startTime = Date.now();

  try {
    // Start transaction
    await client.query("BEGIN");

    if (migration.type === "sql") {
      const sql = fs.readFileSync(migration.path, "utf-8");

      if (!options.dryRun) {
        if (options.verbose) {
          logger.info("Executing SQL migration", {
            name: migration.name,
            preview: sql.substring(0, 200),
          });
        }

        await client.query(sql);
      } else {
        logger.info("DRY RUN: Would execute migration", { name: migration.name });
      }
    }

    const duration = Date.now() - startTime;

    if (!options.dryRun) {
      // Record migration
      await client.query(
        `INSERT INTO ${MIGRATION_TABLE} (name, version, duration_ms, status) 
         VALUES ($1, $2, $3, 'applied')`,
        [migration.name, migration.version, duration],
      );

      await client.query("COMMIT");
      logger.info("Migration applied successfully", {
        name: migration.name,
        duration,
      });
    } else {
      await client.query("ROLLBACK");
      logger.info("DRY RUN: Migration rolled back", { name: migration.name });
    }
  } catch (error) {
    await client.query("ROLLBACK");

    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error("Migration failed", {
      name: migration.name,
      error: errorMsg,
    });

    if (!options.dryRun) {
      await client.query(
        `INSERT INTO ${MIGRATION_TABLE} (name, version, status, error_message) 
         VALUES ($1, $2, 'failed', $3)`,
        [migration.name, migration.version, errorMsg],
      );
    }

    throw error;
  } finally {
    client.release();
  }
}

/**
 * Rollback a migration
 */
export async function rollbackMigration(
  migration: MigrationFile,
  options: MigrationOptions = {},
): Promise<void> {
  const downFilePath = migration.path.replace(".sql", ".down.sql");

  if (!fs.existsSync(downFilePath)) {
    throw new Error(
      `No rollback file found: ${downFilePath}. Create ${path.basename(downFilePath)} to enable rollback.`,
    );
  }

  const client = await pool.connect();
  const startTime = Date.now();

  try {
    await client.query("BEGIN");

    const sql = fs.readFileSync(downFilePath, "utf-8");

    if (!options.dryRun) {
      if (options.verbose) {
        logger.info("Executing rollback migration", {
          name: migration.name,
          preview: sql.substring(0, 200),
        });
      }

      await client.query(sql);
    } else {
      logger.info("DRY RUN: Would execute rollback", { name: migration.name });
    }

    const duration = Date.now() - startTime;

    if (!options.dryRun) {
      await client.query(
        `UPDATE ${MIGRATION_TABLE} SET rolled_back_at = CURRENT_TIMESTAMP, status = 'rolled_back' 
         WHERE name = $1`,
        [migration.name],
      );

      await client.query("COMMIT");
      logger.info("Migration rolled back successfully", {
        name: migration.name,
        duration,
      });
    } else {
      await client.query("ROLLBACK");
      logger.info("DRY RUN: Rollback rolled back", { name: migration.name });
    }
  } catch (error) {
    await client.query("ROLLBACK");
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error("Rollback failed", { name: migration.name, error: errorMsg });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Migrate up to latest or specific version
 */
export async function migrateUp(options: MigrationOptions = {}): Promise<void> {
  const lockId = await acquireMigrationLock();

  if (!lockId) {
    throw new Error("Failed to acquire migration lock");
  }

  try {
    const pending = await getPendingMigrations();

    if (pending.length === 0) {
      logger.info("No pending migrations");
      return;
    }

    logger.info("Starting migration", { count: pending.length });

    for (const migration of pending) {
      if (options.target && migration.version > options.target) {
        break;
      }

      await applyMigration(migration, options);
    }

    logger.info("Migration completed successfully");
  } finally {
    await releaseMigrationLock(lockId);
  }
}

/**
 * Migrate down (rollback) by one or more versions
 */
export async function migrateDown(
  steps: number = 1,
  options: MigrationOptions = {},
): Promise<void> {
  const lockId = await acquireMigrationLock();

  if (!lockId) {
    throw new Error("Failed to acquire migration lock");
  }

  try {
    const applied = await getAppliedMigrations();

    if (applied.length === 0) {
      logger.info("No migrations to rollback");
      return;
    }

    const toRollback = applied.slice(-steps).reverse();
    const allMigrations = discoverMigrations();

    logger.info("Starting rollback", { steps: toRollback.length });

    for (const record of toRollback) {
      const migration = allMigrations.find((m) => m.name === record.name);

      if (!migration) {
        throw new Error(`Migration file not found: ${record.name}`);
      }

      await rollbackMigration(migration, options);
    }

    logger.info("Rollback completed successfully");
  } finally {
    await releaseMigrationLock(lockId);
  }
}

/**
 * Get migration status
 */
export async function getMigrationStatus(): Promise<{
  applied: number;
  pending: number;
  total: number;
  migrations: Array<MigrationFile & { applied?: boolean }>;
}> {
  const allMigrations = discoverMigrations();
  const applied = await getAppliedMigrations();
  const appliedNames = new Set(applied.map((m) => m.name));

  return {
    applied: appliedNames.size,
    pending: allMigrations.length - appliedNames.size,
    total: allMigrations.length,
    migrations: allMigrations.map((m) => ({
      ...m,
      applied: appliedNames.has(m.name),
    })),
  };
}

/**
 * CLI entry point for migration commands
 */
export async function runMigrationCLI(): Promise<void> {
  const command = process.argv[2];
  const options: MigrationOptions = {
    dryRun: process.argv.includes("--dry-run"),
    verbose: process.argv.includes("--verbose"),
  };

  try {
    await initializeMigrationTable();

    switch (command) {
      case "up":
        await migrateUp(options);
        break;

      case "down":
        const steps = parseInt(process.argv[3] || "1", 10);
        await migrateDown(steps, options);
        break;

      case "status":
        const status = await getMigrationStatus();
        console.log(JSON.stringify(status, null, 2));
        break;

      default:
        console.log(`
Usage:
  npx ts-node src/scripts/migrationRunner.ts up [--dry-run] [--verbose]
  npx ts-node src/scripts/migrationRunner.ts down [steps] [--dry-run] [--verbose]
  npx ts-node src/scripts/migrationRunner.ts status
        `);
    }
  } catch (error) {
    logger.error("Migration CLI error", { error: String(error) });
    process.exit(1);
  }
}

// Run CLI if executed directly
if (require.main === module) {
  runMigrationCLI().then(() => process.exit(0));
}
