export {};

const mockOn = jest.fn();
const mockClose = jest.fn().mockResolvedValue(undefined);
const mockWorkerCtor = jest.fn(() => ({
  on: mockOn,
  close: mockClose,
}));

jest.mock("bullmq", () => ({
  Queue: jest.fn(() => ({
    add: jest.fn(),
    close: jest.fn(),
  })),
  Worker: mockWorkerCtor,
}));

jest.mock("../../queue/config", () => ({
  queueOptions: {},
}));

jest.mock("../../jobs/kycExpiryJob", () => ({
  runKYCExpiryJob: jest.fn().mockResolvedValue({ remindersSent: 0, expiredCount: 0 }),
}));

jest.mock("../../queue/trace", () => ({}));

describe("kycExpiryWorker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("starts worker once and closes cleanly", () => {
    const {
      startKYCExpiryWorker,
      closeKYCExpiryWorker,
    } = require("../../queue/kycExpiryWorker");

    startKYCExpiryWorker();
    startKYCExpiryWorker();

    expect(mockWorkerCtor).toHaveBeenCalledTimes(1);

    return closeKYCExpiryWorker().then(() => {
      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });
});