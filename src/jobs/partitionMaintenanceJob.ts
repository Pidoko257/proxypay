import { pool } from "../config/database";

/**
 * Partition Maintenance Job
 *
 * Schedule: 25th of every month at 00:00 (0 0 25 * *)
 *
 * Responsibilities:
 *   1. Creates the next month's partition if it doesn't exist yet, ensuring
 *      the partitioned transactions table always has a ready partition for
 *      incoming writes.
 *   2. Logs partition inventory (all child partitions + row estimates) so
 *      operators can audit partition health.
 *
 * The actual table-to-partitioned-table migration is handled by
 * migrations/009_partition_transactions.sql which runs zero-downtime via the
 * rename-and-attach-as-DEFAULT strategy.
 *
 * Why the 25th?
 *   Running on the 25th gives a comfortable 6-day lead time before the month
 *   boundary. The migration pre-creates current + 2 months ahead, so this job
 *   only needs to stay one month ahead on an ongoing basis.
 */

interface PartitionInfo {
  partition_name: string;
  from_value: string;
  to_value: string;
  estimated_rows: number;
  size_pretty: string;
}

/**
 * Calls the create_monthly_partition() PostgreSQL function defined in
 * migrations/009_partition_transactions.sql.
 *
 * The function is idempotent — it does nothing when the partition already
 * exists, so calling it multiple times is safe.
 */
async function ensureNextMonthPartition(): Promise<string> {
  // Calculate the first day of next month
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const partitionStart = nextMonth.toISOString().slice(0, 10); // YYYY-MM-DD

  await pool.query("SELECT create_monthly_partition($1::DATE)", [
    partitionStart,
  ]);

  const partitionName =
    "transactions_" +
    String(nextMonth.getFullYear()) +
    "_" +
    String(nextMonth.getMonth() + 1).padStart(2, "0");

  return partitionName;
}

/**
 * Returns a list of all child partitions of the transactions table, ordered
 * by range start so operators can see the full partition inventory at a glance.
 */
async function listPartitions(): Promise<PartitionInfo[]> {
  const result = await pool.query<PartitionInfo>(`
    SELECT
      c.relname                                           AS partition_name,
      pg_get_expr(c.relpartbound, c.oid)                 AS from_value,
      ''                                                  AS to_value,
      COALESCE(s.n_live_tup, 0)                          AS estimated_rows,
      pg_size_pretty(pg_relation_size(c.oid))            AS size_pretty
    FROM pg_inherits i
    JOIN pg_class    p ON p.oid = i.inhparent
    JOIN pg_class    c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = p.relnamespace
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
    WHERE p.relname  = 'transactions'
      AND n.nspname  = current_schema()
    ORDER BY c.relname;
  `);

  return result.rows;
}

export async function runPartitionMaintenanceJob(): Promise<void> {
  console.info(
    "[partition-maintenance] Starting partition maintenance job",
  );

  try {
    // 1. Ensure next month's partition exists
    const partitionName = await ensureNextMonthPartition();
    console.info(
      `[partition-maintenance] Ensured next-month partition exists: ${partitionName}`,
    );

    // 2. Log partition inventory
    const partitions = await listPartitions();
    console.info(
      `[partition-maintenance] Current partition inventory (${partitions.length} partition(s)):`,
    );
    for (const p of partitions) {
      console.info(
        `[partition-maintenance]   ${p.partition_name} | rows≈${p.estimated_rows.toLocaleString()} | size=${p.size_pretty} | bound=${p.from_value}`,
      );
    }

    console.info(
      "[partition-maintenance] Partition maintenance job completed successfully",
    );
  } catch (error) {
    console.error(
      "[partition-maintenance] Partition maintenance job failed:",
      error,
    );
    throw error;
  }
}
