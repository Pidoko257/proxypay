/**
 * #650 – Admin dashboard query performance
 *
 * The database is mocked so the plan-parsing, index-recommendation and
 * statistics-sampling logic can be exercised without a live PostgreSQL.
 */
import {
  AdminDashboardQueryPerformanceService,
  DASHBOARD_QUERIES,
  extractFilterColumns,
  type DashboardQuery,
} from "../adminDashboardQueryPerformanceService";
import { queryRead } from "../../config/database";

jest.mock("../../config/database", () => ({
  pool: { query: jest.fn() },
  queryRead: jest.fn(),
  queryWrite: jest.fn(),
}));

const mockedQueryRead = queryRead as jest.Mock;
const mockedQueryWrite = jest.requireMock("../../config/database")
  .queryWrite as jest.Mock;

function service(overrides: Record<string, number> = {}) {
  return new AdminDashboardQueryPerformanceService({
    planCostBudget: 1000,
    minSeqScanCost: 100,
    ...overrides,
  });
}

/** Builds an EXPLAIN (FORMAT JSON) response envelope around a plan node. */
function explainResponse(plan: unknown) {
  return { rows: [{ "QUERY PLAN": [{ Plan: plan }] }] };
}

const SEQ_SCAN_PLAN = {
  "Node Type": "Seq Scan",
  "Relation Name": "transactions",
  Filter: "((status)::text = ANY ('{completed}'::text[]))",
  "Total Cost": 4200.5,
};

const INDEX_SCAN_PLAN = {
  "Node Type": "Index Scan",
  "Relation Name": "transactions",
  "Index Name": "idx_transactions_reference_number",
  "Total Cost": 8.2,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedQueryWrite.mockResolvedValue({
    rows: [
      {
        query_hash: "hash",
        query_fingerprint: "fingerprint",
        plan: {},
        plan_cost: 1,
        hit_count: 0,
        is_regression: false,
        last_used_at: new Date(),
      },
    ],
    rowCount: 1,
  });
});

describe("extractFilterColumns", () => {
  it("reads a cast equality filter", () => {
    expect(
      extractFilterColumns("((reference_number)::text = 'PR-1'::text)"),
    ).toEqual(["reference_number"]);
  });

  it("reads an ANY() filter", () => {
    expect(
      extractFilterColumns("((status)::text = ANY ('{completed}'::text[]))"),
    ).toEqual(["status"]);
  });

  it("deduplicates repeated columns", () => {
    const columns = extractFilterColumns(
      "((a)::text = '1'::text AND (a)::text <> '2'::text)",
    );
    expect(columns).toEqual(["a"]);
  });

  it("returns nothing for a filter it cannot attribute to a column", () => {
    expect(extractFilterColumns(undefined)).toEqual([]);
    expect(extractFilterColumns("")).toEqual([]);
  });
});

describe("explainDashboardQueries", () => {
  it("reports the plan cost and the indexes the planner used", async () => {
    mockedQueryRead.mockResolvedValue(explainResponse(INDEX_SCAN_PLAN));

    const [analysis] = await service().explainDashboardQueries([
      DASHBOARD_QUERIES[0],
    ]);

    expect(analysis.name).toBe(DASHBOARD_QUERIES[0].name);
    expect(analysis.route).toBe(DASHBOARD_QUERIES[0].route);
    expect(analysis.planCost).toBe(8.2);
    expect(analysis.indexesUsed).toEqual([
      "idx_transactions_reference_number",
    ]);
    expect(analysis.seqScannedTables).toEqual([]);
    expect(analysis.overBudget).toBe(false);
    expect(analysis.error).toBeUndefined();
  });

  it("flags a query over the cost budget", async () => {
    mockedQueryRead.mockResolvedValue(explainResponse(SEQ_SCAN_PLAN));

    const [analysis] = await service().explainDashboardQueries([
      DASHBOARD_QUERIES[0],
    ]);

    expect(analysis.planCost).toBe(4200.5);
    expect(analysis.overBudget).toBe(true);
    expect(analysis.seqScannedTables).toEqual(["transactions"]);
  });

  it("collects index names from nested plan nodes", async () => {
    mockedQueryRead.mockResolvedValue(
      explainResponse({
        "Node Type": "Sort",
        "Total Cost": 50,
        Plans: [INDEX_SCAN_PLAN, SEQ_SCAN_PLAN],
      }),
    );

    const [analysis] = await service().explainDashboardQueries([
      DASHBOARD_QUERIES[0],
    ]);

    expect(analysis.indexesUsed).toEqual([
      "idx_transactions_reference_number",
    ]);
    expect(analysis.seqScannedTables).toEqual(["transactions"]);
  });

  it("reports the error for one query without aborting the rest", async () => {
    mockedQueryRead
      .mockRejectedValueOnce(new Error("relation does not exist"))
      .mockResolvedValueOnce(explainResponse(INDEX_SCAN_PLAN));

    const results = await service().explainDashboardQueries([
      DASHBOARD_QUERIES[0],
      DASHBOARD_QUERIES[1],
    ]);

    expect(results[0].error).toBe("relation does not exist");
    expect(results[0].planCost).toBeNull();
    expect(results[1].error).toBeUndefined();
    expect(results[1].planCost).toBe(8.2);
  });

  it("still returns the analysis when the plan cache write fails", async () => {
    mockedQueryRead.mockResolvedValue(explainResponse(INDEX_SCAN_PLAN));
    mockedQueryWrite.mockRejectedValue(new Error("cache table missing"));

    const [analysis] = await service().explainDashboardQueries([
      DASHBOARD_QUERIES[0],
    ]);

    expect(analysis.planCost).toBe(8.2);
    expect(analysis.cachedPlan).toBeUndefined();
  });

  it("analyses every registered dashboard query by default", async () => {
    mockedQueryRead.mockResolvedValue(explainResponse(INDEX_SCAN_PLAN));

    const results = await service().explainDashboardQueries();

    expect(results).toHaveLength(DASHBOARD_QUERIES.length);
    // One EXPLAIN per query; the shared plan cache adds a read of its own.
    const explainCalls = mockedQueryRead.mock.calls.filter(([sql]) =>
      String(sql).startsWith("EXPLAIN"),
    );
    expect(explainCalls).toHaveLength(DASHBOARD_QUERIES.length);
  });
});

describe("recommendMissingIndexes", () => {
  it("derives a CREATE INDEX statement from an unindexed seq scan", async () => {
    mockedQueryRead.mockResolvedValue(explainResponse(SEQ_SCAN_PLAN));

    const recommendations = await service().recommendMissingIndexes([
      DASHBOARD_QUERIES[0],
    ]);

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0].table).toBe("transactions");
    expect(recommendations[0].columns).toEqual(["status"]);
    expect(recommendations[0].createStatement).toBe(
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_status " +
        "ON transactions (status);",
    );
    expect(recommendations[0].sourceQuery).toBe(DASHBOARD_QUERIES[0].name);
    expect(recommendations[0].estimatedCost).toBe(4200.5);
    expect(recommendations[0].reason).toContain(DASHBOARD_QUERIES[0].route);
  });

  it("recommends nothing when the plan already uses an index", async () => {
    mockedQueryRead.mockResolvedValue(explainResponse(INDEX_SCAN_PLAN));

    expect(
      await service().recommendMissingIndexes([DASHBOARD_QUERIES[0]]),
    ).toEqual([]);
  });

  it("ignores a seq scan below the cost floor", async () => {
    mockedQueryRead.mockResolvedValue(
      explainResponse({ ...SEQ_SCAN_PLAN, "Total Cost": 5 }),
    );

    expect(
      await service().recommendMissingIndexes([DASHBOARD_QUERIES[0]]),
    ).toEqual([]);
  });

  it("ignores a seq scan with no filter to index on", async () => {
    mockedQueryRead.mockResolvedValue(
      explainResponse({ ...SEQ_SCAN_PLAN, Filter: undefined }),
    );

    expect(
      await service().recommendMissingIndexes([DASHBOARD_QUERIES[0]]),
    ).toEqual([]);
  });

  it("deduplicates the same table/column pair across queries", async () => {
    mockedQueryRead.mockResolvedValue(explainResponse(SEQ_SCAN_PLAN));

    const queries: DashboardQuery[] = [
      DASHBOARD_QUERIES[0],
      { ...DASHBOARD_QUERIES[0], name: "duplicate_shape" },
    ];

    const recommendations = await service().recommendMissingIndexes(queries);

    expect(recommendations).toHaveLength(1);
  });

  it("skips queries that failed to analyse", async () => {
    mockedQueryRead.mockRejectedValue(new Error("boom"));

    expect(
      await service().recommendMissingIndexes([DASHBOARD_QUERIES[0]]),
    ).toEqual([]);
  });
});

describe("collectQueryPerformanceMetrics", () => {
  it("maps statistics rows and computes the seq-scan ratio", async () => {
    mockedQueryRead.mockResolvedValue({
      rows: [
        {
          table_name: "transactions",
          seq_scan: "900",
          seq_tup_read: "9000000",
          idx_scan: "100",
          live_tuples: "500000",
          dead_tuples: "1200",
          last_seq_scan: "2026-01-01T00:00:00.000Z",
          unused_indexes: "3",
        },
      ],
    });

    const [metric] = await service().collectQueryPerformanceMetrics();

    expect(metric.table).toBe("transactions");
    expect(metric.seqScans).toBe(900);
    expect(metric.indexScans).toBe(100);
    expect(metric.seqScanRatio).toBeCloseTo(0.9, 5);
    expect(metric.unusedIndexes).toBe(3);
    expect(metric.deadTuples).toBe(1200);
  });

  it("returns a zero ratio rather than dividing by zero", async () => {
    mockedQueryRead.mockResolvedValue({
      rows: [
        {
          table_name: "disputes",
          seq_scan: "0",
          idx_scan: "0",
          seq_tup_read: "0",
          live_tuples: "10",
          dead_tuples: "0",
          last_seq_scan: null,
          unused_indexes: "0",
        },
      ],
    });

    const [metric] = await service().collectQueryPerformanceMetrics();

    expect(metric.seqScanRatio).toBe(0);
    expect(metric.lastSeqScan).toBeNull();
  });

  it("returns an empty list instead of throwing when the query fails", async () => {
    mockedQueryRead.mockRejectedValue(new Error("pg_stat not available"));

    await expect(
      service().collectQueryPerformanceMetrics(),
    ).resolves.toEqual([]);
  });
});
