const loggerErrorMock = jest.fn();
const jobFailuresIncMock = jest.fn();

jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    error: (...args: unknown[]) => loggerErrorMock(...args),
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

jest.mock("../../src/utils/metrics", () => ({
  ...jest.requireActual("../../src/utils/metrics"),
  jobFailuresTotal: { inc: (...args: unknown[]) => jobFailuresIncMock(...args) },
}));

import { runJob, JobConfig } from "../../src/jobs/jobRunner";
import type { PagerDutyService } from "../../src/services/pagerDutyService";

function makePagerDuty() {
  return { triggerAlert: jest.fn().mockResolvedValue(undefined) };
}

describe("runJob failure handling", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it("does not record failures for a successful job", async () => {
    const pd = makePagerDuty();
    const job: JobConfig = {
      name: "ok-job",
      schedule: "* * * * *",
      handler: jest.fn().mockResolvedValue(undefined),
      critical: true,
    };

    await runJob(job, pd as unknown as PagerDutyService);

    expect(jobFailuresIncMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).not.toHaveBeenCalled();
    expect(pd.triggerAlert).not.toHaveBeenCalled();
  });

  it("increments the metric and logs, but does not page, for a non-critical job", async () => {
    const pd = makePagerDuty();
    const job: JobConfig = {
      name: "minor-job",
      schedule: "* * * * *",
      handler: jest.fn().mockRejectedValue(new Error("boom")),
    };

    await expect(
      runJob(job, pd as unknown as PagerDutyService),
    ).resolves.toBeUndefined();

    expect(jobFailuresIncMock).toHaveBeenCalledWith({ job_name: "minor-job" });
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    expect(pd.triggerAlert).not.toHaveBeenCalled();
  });

  it("pages on-call when a critical job fails", async () => {
    const pd = makePagerDuty();
    const job: JobConfig = {
      name: "reconciliation",
      schedule: "0 5 * * *",
      handler: jest.fn().mockRejectedValue(new Error("db down")),
      critical: true,
    };

    await runJob(job, pd as unknown as PagerDutyService);

    expect(jobFailuresIncMock).toHaveBeenCalledWith({
      job_name: "reconciliation",
    });
    expect(pd.triggerAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupKey: "job-failure-reconciliation",
        summary: expect.stringContaining("db down"),
      }),
    );
  });

  it("does not throw if the PagerDuty alert itself fails", async () => {
    const pd = { triggerAlert: jest.fn().mockRejectedValue(new Error("pd")) };
    const job: JobConfig = {
      name: "reconciliation",
      schedule: "0 5 * * *",
      handler: jest.fn().mockRejectedValue(new Error("db down")),
      critical: true,
    };

    await expect(
      runJob(job, pd as unknown as PagerDutyService),
    ).resolves.toBeUndefined();
    expect(loggerErrorMock).toHaveBeenCalledTimes(2);
  });
});
