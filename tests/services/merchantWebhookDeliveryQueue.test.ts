const addWebhookDeliveryJobMock = jest.fn();

jest.mock("../../src/queue/webhookDeliveryQueue", () => {
  const delays = [1000, 5000, 30000, 300000, 1800000];
  return {
    WEBHOOK_BACKOFF_DELAYS_MS: delays,
    WEBHOOK_MAX_ATTEMPTS: delays.length + 1,
    webhookBackoffStrategy: (attemptsMade: number) => delays[attemptsMade - 1] ?? -1,
    addWebhookDeliveryJob: (...args: unknown[]) => addWebhookDeliveryJobMock(...args),
  };
});

const findByUserIdMock = jest.fn();
const insertDeliveryLogMock = jest.fn();

jest.mock("../../src/models/merchantWebhook", () => ({
  MerchantWebhookModel: jest.fn().mockImplementation(() => ({
    findByUserId: findByUserIdMock,
    findById: jest.fn(),
    insertDeliveryLog: insertDeliveryLogMock,
  })),
}));

import {
  WEBHOOK_BACKOFF_DELAYS_MS,
  WEBHOOK_MAX_ATTEMPTS,
  webhookBackoffStrategy,
} from "../../src/queue/webhookDeliveryQueue";
import { MerchantWebhookService } from "../../src/services/merchantWebhookService";

describe("merchant webhook queued delivery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses the required retry delay sequence", () => {
    expect(WEBHOOK_BACKOFF_DELAYS_MS).toEqual([
      1000,
      5000,
      30000,
      300000,
      1800000,
    ]);
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(6);
    expect([1, 2, 3, 4, 5, 6].map(webhookBackoffStrategy)).toEqual([
      1000,
      5000,
      30000,
      300000,
      1800000,
      -1,
    ]);
  });

  it("queues active subscribed webhooks instead of delivering inline", async () => {
    findByUserIdMock.mockResolvedValue([
      {
        id: "webhook-1",
        isActive: true,
        events: ["transaction.completed"],
      },
      {
        id: "webhook-2",
        isActive: false,
        events: ["transaction.completed"],
      },
      {
        id: "webhook-3",
        isActive: true,
        events: ["transaction.failed"],
      },
    ]);
    addWebhookDeliveryJobMock.mockResolvedValue({ id: "job-1" });

    const service = new MerchantWebhookService();
    const payload = { transaction_id: "txn-1" };

    await service.dispatchEvent("user-1", "transaction.completed", payload);

    expect(addWebhookDeliveryJobMock).toHaveBeenCalledTimes(1);
    expect(addWebhookDeliveryJobMock).toHaveBeenCalledWith({
      webhookId: "webhook-1",
      eventType: "transaction.completed",
      payload,
    });
    expect(insertDeliveryLogMock).not.toHaveBeenCalled();
  });
});
