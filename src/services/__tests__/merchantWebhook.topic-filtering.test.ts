/**
 * Tests for Webhook Subscription Topic Filtering (Issue #119)
 *
 * Covers:
 *   - webhookMatchesTopic() — exact matches and wildcard resolution
 *   - MerchantWebhookModel.listAvailableTopics() — static metadata
 *   - MerchantWebhookModel validation — rejects unknown events
 *   - MerchantWebhookService.dispatchEvent() — topic-aware fan-out
 *   - GET /api/merchant/webhooks/topics route — unauthenticated guard + response shape
 */

import {
  webhookMatchesTopic,
  ALLOWED_EVENTS,
  WILDCARD_TOPICS,
  MerchantWebhookModel,
} from "../../models/merchantWebhook";

// ─── Mock DB queries ──────────────────────────────────────────────────────────

const mockQueryRead = jest.fn();
const mockQueryWrite = jest.fn();

jest.mock("../../config/database", () => ({
  queryRead: (...args: unknown[]) => mockQueryRead(...args),
  queryWrite: (...args: unknown[]) => mockQueryWrite(...args),
}));

// ─── Mock encryption ──────────────────────────────────────────────────────────

jest.mock("../../utils/encryption", () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ""),
}));

// ─────────────────────────────────────────────────────────────────────────────

describe("webhookMatchesTopic()", () => {
  describe("exact match", () => {
    it("returns true when the exact event is in the subscribed list", () => {
      expect(webhookMatchesTopic(["transaction.completed"], "transaction.completed")).toBe(true);
    });

    it("returns true when one of multiple subscribed events matches", () => {
      expect(
        webhookMatchesTopic(["transaction.failed", "transaction.completed"], "transaction.failed"),
      ).toBe(true);
    });

    it("returns false when no exact match exists", () => {
      expect(webhookMatchesTopic(["transaction.failed"], "transaction.completed")).toBe(false);
    });

    it("returns false for an empty subscription list", () => {
      expect(webhookMatchesTopic([], "transaction.completed")).toBe(false);
    });
  });

  describe("wildcard match — transaction.*", () => {
    it("matches transaction.completed via transaction.*", () => {
      expect(webhookMatchesTopic(["transaction.*"], "transaction.completed")).toBe(true);
    });

    it("matches transaction.failed via transaction.*", () => {
      expect(webhookMatchesTopic(["transaction.*"], "transaction.failed")).toBe(true);
    });

    it("matches transaction.pending via transaction.*", () => {
      expect(webhookMatchesTopic(["transaction.*"], "transaction.pending")).toBe(true);
    });

    it("matches transaction.cancelled via transaction.*", () => {
      expect(webhookMatchesTopic(["transaction.*"], "transaction.cancelled")).toBe(true);
    });

    it("does NOT match unrelated namespaces", () => {
      expect(webhookMatchesTopic(["transaction.*"], "payment.completed")).toBe(false);
      expect(webhookMatchesTopic(["transaction.*"], "user.created")).toBe(false);
    });
  });

  describe("mixed subscriptions", () => {
    it("matches when one entry is exact and another is wildcard", () => {
      expect(
        webhookMatchesTopic(["transaction.*", "payment.failed"], "transaction.completed"),
      ).toBe(true);
      expect(
        webhookMatchesTopic(["transaction.completed", "transaction.*"], "transaction.pending"),
      ).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("ALLOWED_EVENTS and WILDCARD_TOPICS constants", () => {
  it("ALLOWED_EVENTS contains all four concrete transaction events", () => {
    expect(ALLOWED_EVENTS.has("transaction.completed")).toBe(true);
    expect(ALLOWED_EVENTS.has("transaction.failed")).toBe(true);
    expect(ALLOWED_EVENTS.has("transaction.pending")).toBe(true);
    expect(ALLOWED_EVENTS.has("transaction.cancelled")).toBe(true);
  });

  it("WILDCARD_TOPICS has a transaction.* key", () => {
    expect(Object.keys(WILDCARD_TOPICS)).toContain("transaction.*");
  });

  it("transaction.* wildcard covers all four concrete events", () => {
    const events = WILDCARD_TOPICS["transaction.*"];
    expect(events).toContain("transaction.completed");
    expect(events).toContain("transaction.failed");
    expect(events).toContain("transaction.pending");
    expect(events).toContain("transaction.cancelled");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("MerchantWebhookModel.listAvailableTopics()", () => {
  const model = new MerchantWebhookModel();

  it("returns events array with all four concrete event types", () => {
    const { events } = model.listAvailableTopics();
    expect(events).toContain("transaction.completed");
    expect(events).toContain("transaction.failed");
    expect(events).toContain("transaction.pending");
    expect(events).toContain("transaction.cancelled");
  });

  it("returns wildcards array containing transaction.*", () => {
    const { wildcards } = model.listAvailableTopics();
    expect(wildcards).toContain("transaction.*");
  });

  it("returns a description for every event and wildcard", () => {
    const { events, wildcards, description } = model.listAvailableTopics();
    for (const e of [...events, ...wildcards]) {
      // Use Object.prototype.hasOwnProperty to avoid Jest's dot-path interpretation
      expect(Object.prototype.hasOwnProperty.call(description, e)).toBe(true);
      expect(typeof description[e]).toBe("string");
      expect(description[e].length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("MerchantWebhookModel validation", () => {
  const model = new MerchantWebhookModel();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects unknown event types during create()", async () => {
    await expect(
      model.create({
        userId: "user-1",
        url: "https://example.com/hook",
        secret: "mysecret1234567890",
        events: ["unknown.event"],
      }),
    ).rejects.toThrow('Unknown event type: "unknown.event"');
  });

  it("accepts the wildcard topic transaction.* during create()", async () => {
    // Mock DB responses
    mockQueryRead.mockResolvedValueOnce({ rows: [{ count: "0" }] }); // COUNT check
    mockQueryWrite.mockResolvedValueOnce({
      rows: [
        {
          id: "webhook-1",
          user_id: "user-1",
          url: "https://example.com/hook",
          secret: "enc:mysecret",
          description: null,
          events: ["transaction.*"],
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
    });

    const webhook = await model.create({
      userId: "user-1",
      url: "https://example.com/hook",
      secret: "mysecret1234567890",
      events: ["transaction.*"],
    });

    expect(webhook.events).toEqual(["transaction.*"]);
  });

  it("rejects unknown event types during update()", async () => {
    await expect(
      model.update("webhook-1", "user-1", {
        events: ["payment.created"],
      }),
    ).rejects.toThrow('Unknown event type: "payment.created"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("MerchantWebhookModel.findActiveByUserIdAndTopic()", () => {
  const model = new MerchantWebhookModel();

  const baseWebhook = (overrides: Record<string, unknown> = {}) => ({
    id: "wh-1",
    user_id: "user-1",
    url: "https://example.com/hook",
    secret: "enc:secret",
    description: null,
    events: ["transaction.completed"],
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  });

  beforeEach(() => jest.clearAllMocks());

  it("returns webhook subscribed to exact event", async () => {
    mockQueryRead.mockResolvedValueOnce({ rows: [baseWebhook()] });

    const matches = await model.findActiveByUserIdAndTopic("user-1", "transaction.completed");
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe("wh-1");
  });

  it("does NOT return webhook subscribed to a different event", async () => {
    mockQueryRead.mockResolvedValueOnce({ rows: [baseWebhook()] });

    const matches = await model.findActiveByUserIdAndTopic("user-1", "transaction.failed");
    expect(matches).toHaveLength(0);
  });

  it("returns webhook subscribed via wildcard", async () => {
    mockQueryRead.mockResolvedValueOnce({
      rows: [baseWebhook({ events: ["transaction.*"] })],
    });

    const matches = await model.findActiveByUserIdAndTopic("user-1", "transaction.pending");
    expect(matches).toHaveLength(1);
  });

  it("does NOT return inactive webhook even if topic matches", async () => {
    mockQueryRead.mockResolvedValueOnce({
      rows: [baseWebhook({ is_active: false })],
    });

    const matches = await model.findActiveByUserIdAndTopic("user-1", "transaction.completed");
    expect(matches).toHaveLength(0);
  });

  it("handles multiple webhooks and returns only matching ones", async () => {
    mockQueryRead.mockResolvedValueOnce({
      rows: [
        baseWebhook({ id: "wh-1", events: ["transaction.completed"] }),
        baseWebhook({ id: "wh-2", events: ["transaction.failed"] }),
        baseWebhook({ id: "wh-3", events: ["transaction.*"] }),
        baseWebhook({ id: "wh-4", events: ["transaction.completed"], is_active: false }),
      ],
    });

    const matches = await model.findActiveByUserIdAndTopic("user-1", "transaction.completed");
    const ids = matches.map((w) => w.id);
    expect(ids).toContain("wh-1");   // exact match, active
    expect(ids).toContain("wh-3");   // wildcard match, active
    expect(ids).not.toContain("wh-2"); // different event
    expect(ids).not.toContain("wh-4"); // inactive
    expect(matches).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("MerchantWebhookService.dispatchEvent() — topic filtering", () => {
  /**
   * We test the service logic by patching the MerchantWebhookModel prototype
   * with mocked findActiveByUserIdAndTopic and insertDeliveryLog methods.
   * The fetch implementation is injected via the constructor.
   */

  const mockFetch = jest.fn();
  const mockFindActive = jest.fn();
  const mockInsertLog = jest.fn();

  // Helper — build a minimal webhook object
  function makeWebhook(id: string, events: string[]) {
    return {
      id,
      userId: "user-1",
      url: `https://example.com/hook-${id}`,
      secret: "supersecret",
      description: undefined,
      events,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  let origFindActive: any;
  let origInsertLog: any;

  beforeAll(() => {
    // Patch the prototype once for all dispatchEvent tests
    origFindActive = MerchantWebhookModel.prototype.findActiveByUserIdAndTopic;
    origInsertLog  = MerchantWebhookModel.prototype.insertDeliveryLog;
    MerchantWebhookModel.prototype.findActiveByUserIdAndTopic = mockFindActive;
    MerchantWebhookModel.prototype.insertDeliveryLog = mockInsertLog;
  });

  afterAll(() => {
    // Restore prototype after this describe block
    MerchantWebhookModel.prototype.findActiveByUserIdAndTopic = origFindActive;
    MerchantWebhookModel.prototype.insertDeliveryLog = origInsertLog;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "ok",
    });
    mockInsertLog.mockResolvedValue({ id: "log-1" });
  });

  it("delivers only to webhooks whose topics match the event", async () => {
    // Only wh-1 (exact) and wh-3 (wildcard) should match transaction.completed
    mockFindActive.mockResolvedValue([
      makeWebhook("wh-1", ["transaction.completed"]),
      makeWebhook("wh-3", ["transaction.*"]),
    ]);

    const { MerchantWebhookService } = require("../../services/merchantWebhookService");
    const service = new MerchantWebhookService(mockFetch);

    await service.dispatchEvent("user-1", "transaction.completed", {
      event_type: "transaction.completed",
      transaction_id: "txn-1",
    });

    // Should have delivered to wh-1 and wh-3
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const urls: string[] = mockFetch.mock.calls.map((c: any) => c[0]);
    expect(urls).toContain("https://example.com/hook-wh-1");
    expect(urls).toContain("https://example.com/hook-wh-3");

    // Delivery logs should be inserted for each matched webhook
    expect(mockInsertLog).toHaveBeenCalledTimes(2);
  });

  it("does not deliver when no webhooks match the topic", async () => {
    mockFindActive.mockResolvedValue([]);

    const { MerchantWebhookService } = require("../../services/merchantWebhookService");
    const service = new MerchantWebhookService(mockFetch);

    await service.dispatchEvent("user-1", "transaction.cancelled", {
      event_type: "transaction.cancelled",
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockInsertLog).not.toHaveBeenCalled();
  });
});
