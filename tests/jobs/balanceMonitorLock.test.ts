const redisSetMock = jest.fn();
const loggerErrorMock = jest.fn();
const redisClientMock: { isOpen: boolean; set: jest.Mock } = {
  isOpen: true,
  set: (...args: unknown[]) => redisSetMock(...args),
} as unknown as { isOpen: boolean; set: jest.Mock };

jest.mock("../../src/config/redis", () => ({
  redisClient: redisClientMock,
}));

jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    error: (...args: unknown[]) => loggerErrorMock(...args),
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

jest.mock("../../src/services/loggers", () => ({
  notifySlackAlert: jest.fn(),
}));

jest.mock("../../src/config/stellar", () => ({
  getStellarServer: () => ({ loadAccount: jest.fn() }),
}));

import { acquireBalanceMonitorLock } from "../../src/jobs/balanceMonitorJob";

describe("acquireBalanceMonitorLock", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redisClientMock.isOpen = true;
  });

  it("returns true when the lock is acquired", async () => {
    redisSetMock.mockResolvedValue("OK");
    await expect(acquireBalanceMonitorLock()).resolves.toBe(true);
  });

  it("returns false when another instance holds the lock", async () => {
    redisSetMock.mockResolvedValue(null);
    await expect(acquireBalanceMonitorLock()).resolves.toBe(false);
  });

  it("fails closed and logs at error level when Redis errors", async () => {
    redisSetMock.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(acquireBalanceMonitorLock()).resolves.toBe(false);
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
  });
});
