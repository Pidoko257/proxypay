export {};

const mockAdd = jest.fn();
const mockClose = jest.fn();

jest.mock("bullmq", () => ({
  Queue: jest.fn(() => ({ add: mockAdd, close: mockClose })),
}));

jest.mock("../../src/queue/config", () => ({ queueOptions: {} }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { scheduleMomoReconciliationJob } = require("../../src/queue/momoReconciliationQueue");

describe("momoReconciliationQueue", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("schedules repeat job every 10 minutes by default", async () => {
    await scheduleMomoReconciliationJob();

    expect(mockAdd).toHaveBeenCalledWith(
      "reconcile-momo-transactions",
      { triggeredBy: "scheduler" },
      expect.objectContaining({
        jobId: "reconcile-momo-transactions",
        repeat: { every: 600000 },
        attempts: 3,
      }),
    );
  });

  it("schedules with correct removeOnComplete and removeOnFail settings", async () => {
    await scheduleMomoReconciliationJob();

    expect(mockAdd).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        removeOnComplete: { count: 100, age: 86400 },
        removeOnFail: { count: 500, age: 604800 },
      }),
    );
  });

  it("schedules with exponential backoff", async () => {
    await scheduleMomoReconciliationJob();

    expect(mockAdd).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        backoff: { type: "exponential", delay: 5000 },
      }),
    );
  });
});
