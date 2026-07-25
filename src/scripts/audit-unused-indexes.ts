/**
 * Unused Index Audit Script
 * Issue: #169 – Database Indexing Strategy
 *
 * Queries pg_stat_user_indexes to find indexes that have never been scanned,
 * and pg_index to detect redundant/duplicate index definitions.
 *
 * Usage:
 *   npx tsx src/scripts/audit-unused-indexes.ts
 *
 * Output: human-readable report in the terminal.
 */

import { pool } from "../config/database";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function hr(char = "─", width = 80): string {
  return char.repeat(width);
}

function padEnd(str: string, len: number): string {
  return str.padEnd(len).slice(0, len);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Query: never-used indexes (idx_scan = 0, excluding primary keys)
// ─────────────────────────────────────────────────────────────────────────────

async function auditNeverUsedIndexes(): Promise<void> {
  const sql = `
    SELECT
      s.schemaname,
      s.relname         AS table_name,
      s.indexrelname    AS index_name,
      s.idx_scan,
      s.idx_tup_read,
      s.idx_tup_fetch,
      pg_size_pretty(pg_relation_size(s.indexrelid)) AS index_size,
      pg_relation_size(s.indexrelid)                 AS index_bytes,
      ix.indisunique    AS is_unique,
      ix.indisprimary   AS is_primary
    FROM pg_stat_user_indexes s
    JOIN pg_index ix ON ix.indexrelid = s.indexrelid
    WHERE s.idx_scan = 0
      AND ix.indisprimary = false
    ORDER BY pg_relation_size(s.indexrelid) DESC, s.relname, s.indexrelname
  `;

  const { rows } = await pool.query(sql);

  console.log("\n" + hr());
  console.log("NEVER-USED INDEXES (idx_scan = 0, excluding primary keys)");
  console.log(hr());

  if (rows.length === 0) {
    console.log("✅  No unused indexes found.");
    return;
  }

  console.log(
    `${padEnd("Table", 35)} ${padEnd("Index", 50)} ${padEnd("Unique", 7)} ${padEnd("Size", 10)} Action`,
  );
  console.log(hr("-"));

  let totalWastedBytes = 0;
  for (const row of rows) {
    const action = row.is_unique ? "REVIEW (unique)" : "DROP CANDIDATE";
    console.log(
      `${padEnd(row.table_name, 35)} ${padEnd(row.index_name, 50)} ${padEnd(row.is_unique ? "Y" : "N", 7)} ${padEnd(row.index_size, 10)} ${action}`,
    );
    totalWastedBytes += parseInt(row.index_bytes, 10);
  }

  console.log(hr("-"));
  console.log(`Total reclaimable space: ${formatBytes(totalWastedBytes)} across ${rows.length} index(es)`);

  console.log("\nTo drop a candidate (run in psql or via migration):");
  const dropCandidates = rows.filter((r) => !r.is_unique);
  for (const row of dropCandidates.slice(0, 5)) {
    console.log(`  DROP INDEX CONCURRENTLY IF EXISTS ${row.index_name};`);
  }
  if (dropCandidates.length > 5) {
    console.log(`  ... and ${dropCandidates.length - 5} more`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Query: low-usage indexes (scanned but rarely, relative to table seq scans)
// ─────────────────────────────────────────────────────────────────────────────

async function auditLowUsageIndexes(): Promise<void> {
  const sql = `
    SELECT
      s.relname                                        AS table_name,
      s.indexrelname                                   AS index_name,
      s.idx_scan,
      t.seq_scan                                       AS table_seq_scan,
      CASE WHEN t.seq_scan = 0 THEN NULL
           ELSE ROUND((s.idx_scan::numeric / t.seq_scan) * 100, 2)
      END                                              AS idx_to_seq_ratio_pct,
      pg_size_pretty(pg_relation_size(s.indexrelid))   AS index_size,
      ix.indisunique                                   AS is_unique
    FROM pg_stat_user_indexes s
    JOIN pg_stat_user_tables  t  ON t.relid = s.relid
    JOIN pg_index             ix ON ix.indexrelid = s.indexrelid
    WHERE s.idx_scan > 0
      AND s.idx_scan < 100
      AND ix.indisprimary = false
      AND t.seq_scan > 50
    ORDER BY s.idx_scan ASC, pg_relation_size(s.indexrelid) DESC
    LIMIT 20
  `;

  const { rows } = await pool.query(sql);

  console.log("\n" + hr());
  console.log("LOW-USAGE INDEXES (< 100 scans, table seq-scanned > 50 times)");
  console.log(hr());

  if (rows.length === 0) {
    console.log("✅  No low-usage indexes found.");
    return;
  }

  console.log(
    `${padEnd("Table", 35)} ${padEnd("Index", 45)} ${padEnd("Scans", 8)} ${padEnd("Ratio%", 8)} ${padEnd("Unique", 7)} Size`,
  );
  console.log(hr("-"));

  for (const row of rows) {
    const ratio = row.idx_to_seq_ratio_pct != null ? `${row.idx_to_seq_ratio_pct}%` : "N/A";
    console.log(
      `${padEnd(row.table_name, 35)} ${padEnd(row.index_name, 45)} ${padEnd(String(row.idx_scan), 8)} ${padEnd(ratio, 8)} ${padEnd(row.is_unique ? "Y" : "N", 7)} ${row.index_size}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Query: duplicate indexes (same table + columns, different names)
// ─────────────────────────────────────────────────────────────────────────────

async function auditDuplicateIndexes(): Promise<void> {
  const sql = `
    SELECT
      t.relname                   AS table_name,
      array_agg(i.relname)        AS index_names,
      array_agg(ix.indkey::text)  AS index_columns,
      count(*)                    AS duplicate_count
    FROM pg_index  ix
    JOIN pg_class  i  ON i.oid = ix.indexrelid
    JOIN pg_class  t  ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND ix.indisprimary = false
    GROUP BY t.relname, ix.indkey::text, ix.indpred::text
    HAVING count(*) > 1
    ORDER BY t.relname
  `;

  const { rows } = await pool.query(sql);

  console.log("\n" + hr());
  console.log("DUPLICATE INDEXES (same table + column set)");
  console.log(hr());

  if (rows.length === 0) {
    console.log("✅  No duplicate indexes found.");
    return;
  }

  for (const row of rows) {
    console.log(`Table: ${row.table_name}`);
    console.log(`  Indexes: ${row.index_names.join(", ")}`);
    console.log(`  Columns: ${row.index_columns[0]}`);
    console.log(`  → Keep one, drop the rest.`);
    console.log();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Query: oversized indexes relative to their table
// ─────────────────────────────────────────────────────────────────────────────

async function auditOversizedIndexes(): Promise<void> {
  const sql = `
    SELECT
      t.relname                                       AS table_name,
      i.relname                                       AS index_name,
      pg_size_pretty(pg_relation_size(i.oid))         AS index_size,
      pg_size_pretty(pg_relation_size(t.oid))         AS table_size,
      ROUND(
        pg_relation_size(i.oid)::numeric /
        NULLIF(pg_relation_size(t.oid), 0) * 100, 1
      )                                               AS idx_pct_of_table,
      s.idx_scan
    FROM pg_class    t
    JOIN pg_index    ix ON ix.indrelid = t.oid
    JOIN pg_class    i  ON i.oid = ix.indexrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.oid
    WHERE n.nspname = 'public'
      AND t.relkind = 'r'
      AND ix.indisprimary = false
      AND pg_relation_size(t.oid) > 0
      AND pg_relation_size(i.oid) > pg_relation_size(t.oid)
    ORDER BY pg_relation_size(i.oid) DESC
  `;

  const { rows } = await pool.query(sql);

  console.log("\n" + hr());
  console.log("OVERSIZED INDEXES (larger than their table — candidates for REINDEX)");
  console.log(hr());

  if (rows.length === 0) {
    console.log("✅  No oversized indexes found.");
    return;
  }

  console.log(
    `${padEnd("Table", 35)} ${padEnd("Index", 45)} ${padEnd("Idx Size", 10)} ${padEnd("Tbl Size", 10)} ${padEnd("Idx%", 7)} Scans`,
  );
  console.log(hr("-"));

  for (const row of rows) {
    console.log(
      `${padEnd(row.table_name, 35)} ${padEnd(row.index_name, 45)} ${padEnd(row.index_size, 10)} ${padEnd(row.table_size, 10)} ${padEnd(`${row.idx_pct_of_table}%`, 7)} ${row.idx_scan ?? "N/A"}`,
    );
  }

  console.log("\nRun: npm run reindex:bloated-indexes  to REINDEX these concurrently.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("ProxyPay — Unused Index Audit");
  console.log(`Run at: ${new Date().toISOString()}`);

  try {
    await auditNeverUsedIndexes();
    await auditLowUsageIndexes();
    await auditDuplicateIndexes();
    await auditOversizedIndexes();

    console.log("\n" + hr());
    console.log("Audit complete.");
    console.log(hr());
  } catch (err) {
    console.error("Audit failed:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
