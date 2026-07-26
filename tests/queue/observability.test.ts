const mockSyncQueue = {
  getJobCounts: jest.fn(),
  getFailed: jest.fn(),
};
const mockAccountMergeQueue = {
  getJobCounts: jest.fn(),
  getFailed: jest.fn(),
};
const mockProviderBalanceAlertQueue = {
  getJobCounts: jest.fn(),
  getFailed: jest.fn(),
};
const mockAccountingTokenRefreshQueue = {
  getJobCounts: jest.fn(),
  getFailed: jest.fn(),
};

jest.mock("../../src/queue/syncQueue", () => ({
  syncQueue: mockSyncQueue,
  SYNC_QUEUE_NAME: "accounting-sync",
}));

jest.mock("../../src/queue/accountMergeQueue", () => ({
  accountMergeQueue: mockAccountMergeQueue,
  ACCOUNT_MERGE_QUEUE_NAME: "account-merge",
}));

jest.mock("../../src/queue/providerBalanceAlertQueue", () => ({
  providerBalanceAlertQueue: mockProviderBalanceAlertQueue,
  PROVIDER_BALANCE_ALERT_QUEUE_NAME: "provider-balance-alerts",
}));

jest.mock("../../src/queue/accountingTokenRefreshQueue", () => ({
  accountingTokenRefreshQueue: mockAccountingTokenRefreshQueue,
  ACCOUNTING_TOKEN_REFRESH_QUEUE_NAME: "accounting-token-refresh",
}));

import {
  getAllQueueMetrics,
  getQueueFailedJobs,
  getMonitoredQueueNames,
  MAX_FAILED_JOBS,
} from "../../src/queue/observability";

describe("Queue Observability Service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getMonitoredQueueNames", () => {
    it("returns all four registered BullMQ queue names", () => {
      expect(getMonitoredQueueNames()).toEqual([
        "accounting-sync",
        "account-merge",
        "provider-balance-alerts",
        "accounting-token-refresh",
      ]);
    });
  });

  describe("getAllQueueMetrics", () => {
    it("returns waiting/active/completed/failed/delayed counts for every queue", async () => {
      const counts = { waiting: 1, active: 2, completed: 3, failed: 4, delayed: 5 };
      mockSyncQueue.getJobCounts.mockResolvedValue(counts);
      mockAccountMergeQueue.getJobCounts.mockResolvedValue(counts);
      mockProviderBalanceAlertQueue.getJobCounts.mockResolvedValue(counts);
      mockAccountingTokenRefreshQueue.getJobCounts.mockResolvedValue(counts);

      const metrics = await getAllQueueMetrics();

      expect(metrics).toHaveLength(4);
      expect(metrics).toContainEqual({
        name: "accounting-sync",
        waiting: 1,
        active: 2,
        completed: 3,
        failed: 4,
        delayed: 5,
      });
      expect(mockSyncQueue.getJobCounts).toHaveBeenCalledWith(
        "waiting",
        "active",
        "completed",
        "failed",
        "delayed",
      );
    });

    it("defaults missing counts to 0", async () => {
      mockSyncQueue.getJobCounts.mockResolvedValue({});
      mockAccountMergeQueue.getJobCounts.mockResolvedValue({});
      mockProviderBalanceAlertQueue.getJobCounts.mockResolvedValue({});
      mockAccountingTokenRefreshQueue.getJobCounts.mockResolvedValue({});

      const metrics = await getAllQueueMetrics();

      expect(metrics.every((m) => m.waiting === 0 && m.failed === 0)).toBe(true);
    });
  });

  describe("getQueueFailedJobs", () => {
    it("throws a NOT_FOUND error for an unknown queue name", async () => {
      await expect(getQueueFailedJobs("not-a-real-queue")).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });

    it("returns failed jobs sorted most-recent-first, capped at MAX_FAILED_JOBS", async () => {
      const makeJob = (id: string, finishedOn: number) => ({
        id,
        name: "sync-operation",
        failedReason: `error-${id}`,
        stacktrace: [`stack-${id}`],
        attemptsMade: 3,
        timestamp: finishedOn - 100,
        finishedOn,
      });

      const jobs = Array.from({ length: 15 }, (_, i) => makeJob(`job-${i}`, 1000 + i));
      mockSyncQueue.getFailed.mockResolvedValue(jobs);

      const result = await getQueueFailedJobs("accounting-sync");

      expect(result).toHaveLength(MAX_FAILED_JOBS);
      expect(result[0].id).toBe("job-14");
      expect(result[0].failedAt).toBe(1014);
      expect(result[9].id).toBe("job-5");
    });

    it("does not expose raw job payload data", async () => {
      const job = {
        id: "job-1",
        name: "merge-account",
        failedReason: "boom",
        stacktrace: [],
        attemptsMade: 1,
        timestamp: 1,
        finishedOn: 2,
        data: { sourceSecret: "SECRET_KEY_SHOULD_NOT_LEAK" },
      };
      mockAccountMergeQueue.getFailed.mockResolvedValue([job]);

      const result = await getQueueFailedJobs("account-merge");

      expect(result[0]).not.toHaveProperty("data");
      expect(JSON.stringify(result)).not.toContain("SECRET_KEY_SHOULD_NOT_LEAK");
    });

    it("falls back to a default error message when failedReason is empty", async () => {
      const job = {
        id: "job-1",
        name: "job",
        failedReason: "",
        stacktrace: [],
        attemptsMade: 1,
        timestamp: 1,
        finishedOn: 2,
      };
      mockSyncQueue.getFailed.mockResolvedValue([job]);

      const result = await getQueueFailedJobs("accounting-sync");

      expect(result[0].failedReason).toBe("Unknown error");
    });
  });
});
