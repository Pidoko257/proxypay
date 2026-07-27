const mockPoolQuery = jest.fn();

jest.mock("../../src/config/database", () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}));

import { runPartitionMaintenanceJob } from "../../src/jobs/partitionMaintenanceJob";

const MOCK_PARTITIONS = [
  {
    partition_name: "transactions_legacy",
    from_value: "DEFAULT",
    to_value: "",
    estimated_rows: 500000,
    size_pretty: "512 MB",
  },
  {
    partition_name: "transactions_2026_07",
    from_value: "FOR VALUES FROM ('2026-07-01') TO ('2026-08-01')",
    to_value: "",
    estimated_rows: 12345,
    size_pretty: "24 MB",
  },
  {
    partition_name: "transactions_2026_08",
    from_value: "FOR VALUES FROM ('2026-08-01') TO ('2026-09-01')",
    to_value: "",
    estimated_rows: 0,
    size_pretty: "8192 bytes",
  },
];

describe("runPartitionMaintenanceJob", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls create_monthly_partition for the next month then lists partitions", async () => {
    // First call: create_monthly_partition, second call: list partitions
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })          // create_monthly_partition
      .mockResolvedValueOnce({ rows: MOCK_PARTITIONS }); // listPartitions

    await runPartitionMaintenanceJob();

    expect(mockPoolQuery).toHaveBeenCalledTimes(2);

    // First query should invoke the create_monthly_partition function
    const [firstQuery, firstParams] = mockPoolQuery.mock.calls[0];
    expect(firstQuery).toContain("create_monthly_partition");
    expect(firstParams).toHaveLength(1);

    // The date param should be a valid YYYY-MM-DD string for next month
    const dateParam: string = firstParams[0];
    expect(dateParam).toMatch(/^\d{4}-\d{2}-01$/);

    // Verify it's actually next month relative to today
    const now = new Date();
    const expectedNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const expectedDateStr = expectedNextMonth.toISOString().slice(0, 10);
    expect(dateParam).toBe(expectedDateStr);
  });

  it("logs partition inventory returned by listPartitions", async () => {
    const consoleSpy = jest.spyOn(console, "info").mockImplementation(() => {});

    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: MOCK_PARTITIONS });

    await runPartitionMaintenanceJob();

    // Should have logged each partition name
    const loggedMessages = consoleSpy.mock.calls.map((c) => c[0] as string);
    expect(
      loggedMessages.some((m) => m.includes("transactions_legacy")),
    ).toBe(true);
    expect(
      loggedMessages.some((m) => m.includes("transactions_2026_07")),
    ).toBe(true);

    consoleSpy.mockRestore();
  });

  it("throws and logs an error when the DB call fails", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    const dbError = new Error("connection refused");
    mockPoolQuery.mockRejectedValueOnce(dbError);

    await expect(runPartitionMaintenanceJob()).rejects.toThrow(
      "connection refused",
    );

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("[partition-maintenance]"),
      dbError,
    );

    consoleError.mockRestore();
  });
});
