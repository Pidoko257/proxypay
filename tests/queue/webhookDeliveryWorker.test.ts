const workerConstructors: any[] = [];

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn(),
    close: jest.fn(),
  })),
  Worker: jest.fn().mockImplementation((queueName, processor, options) => {
    const worker = {
      queueName,
      processor,
      options,
      on: jest.fn(),
      close: jest.fn(),
    };
    workerConstructors.push(worker);
    return worker;
  }),
}));

jest.mock("../../src/queue/config", () => ({
  queueOptions: { connection: {} },
}));

const axiosPostMock = jest.fn();

jest.mock("axios", () => ({
  __esModule: true,
  default: {
    post: (...args: unknown[]) => axiosPostMock(...args),
  },
}));

const findByIdMock = jest.fn();
const insertDeliveryAttemptMock = jest.fn();

jest.mock("../../src/models/merchantWebhook", () => ({
  MerchantWebhookModel: jest.fn().mockImplementation(() => ({
    findById: findByIdMock,
    insertDeliveryAttempt: insertDeliveryAttemptMock,
  })),
}));

jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

import {
  WEBHOOK_DELIVERY_FAILED_EVENT,
  webhookEvents,
} from "../../src/events/webhookEvents";
import {
  WEBHOOK_MAX_ATTEMPTS,
  WebhookDeliveryJobData,
} from "../../src/queue/webhookDeliveryQueue";
import {
  WEBHOOK_TIMEOUT_MS,
  closeWebhookDeliveryWorker,
  startWebhookDeliveryWorker,
} from "../../src/queue/webhookDeliveryWorker";

function buildJob(overrides: Partial<any> = {}) {
  return {
    id: "job-1",
    attemptsMade: 0,
    data: {
      webhookId: "webhook-1",
      eventType: "transaction.completed",
      payload: { transaction_id: "txn-1" },
    } satisfies WebhookDeliveryJobData,
    ...overrides,
  };
}

describe("webhook delivery worker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    workerConstructors.length = 0;
    webhookEvents.removeAllListeners();
    findByIdMock.mockResolvedValue({
      id: "webhook-1",
      url: "https://merchant.example/webhook",
      secret: "super-secret",
      isActive: true,
      events: ["transaction.completed"],
    });
    insertDeliveryAttemptMock.mockResolvedValue({});
  });

  afterEach(async () => {
    await closeWebhookDeliveryWorker();
  });

  it("delivers with a 30 second Axios timeout and logs the attempt", async () => {
    axiosPostMock.mockResolvedValue({ status: 204, data: "" });
    startWebhookDeliveryWorker();

    await workerConstructors[0].processor(buildJob());

    expect(axiosPostMock).toHaveBeenCalledWith(
      "https://merchant.example/webhook",
      JSON.stringify({ transaction_id: "txn-1" }),
      expect.objectContaining({
        timeout: WEBHOOK_TIMEOUT_MS,
        validateStatus: expect.any(Function),
      }),
    );
    expect(insertDeliveryAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookId: "webhook-1",
        eventType: "transaction.completed",
        status: "delivered",
        httpStatus: 204,
        attemptNumber: 1,
        jobId: "job-1",
      }),
    );
  });

  it("emits webhook.delivery_failed after the final retry is exhausted", async () => {
    const listener = jest.fn();
    webhookEvents.on(WEBHOOK_DELIVERY_FAILED_EVENT, listener);
    axiosPostMock.mockRejectedValue(new Error("timeout"));
    startWebhookDeliveryWorker();

    await expect(
      workerConstructors[0].processor(
        buildJob({ attemptsMade: WEBHOOK_MAX_ATTEMPTS - 1 }),
      ),
    ).rejects.toThrow("timeout");

    expect(insertDeliveryAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorMessage: "timeout",
        attemptNumber: WEBHOOK_MAX_ATTEMPTS,
      }),
    );
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookId: "webhook-1",
        eventType: "transaction.completed",
        attemptsMade: WEBHOOK_MAX_ATTEMPTS,
        errorMessage: "timeout",
      }),
    );
  });
});
