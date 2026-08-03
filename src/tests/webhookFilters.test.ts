/**
 * Tests for webhook subscription topic filtering (Issue #119)
 *
 * Acceptance criteria:
 *  - Optional filters JSON (amount_min, currency, provider, status)
 *  - Dispatch checks filters before delivery
 *  - AND logic across specified filters
 *  - Subscriptions without filters still receive all events
 */

const mockModel = {
  findByUserId: jest.fn(),
  findById: jest.fn(),
  insertDeliveryLog: jest.fn(),
};

jest.mock("../models/merchantWebhook", () => {
  const actual = jest.requireActual("../models/merchantWebhook");
  return {
    ...actual,
    MerchantWebhookModel: jest.fn().mockImplementation(() => mockModel),
  };
});

import {
  matchesWebhookFilters,
  parseWebhookFilters,
} from "../services/webhookFilters";
import { MerchantWebhookService } from "../services/merchantWebhookService";
import type { MerchantWebhook } from "../models/merchantWebhook";

const basePayload: Record<string, unknown> = {
  event_type: "transaction.completed",
  amount: "150.00",
  currency: "USD",
  provider: "mtn",
  status: "completed",
  transaction_id: "tx-1",
};

function makeWebhook(
  overrides: Partial<MerchantWebhook> = {},
): MerchantWebhook {
  return {
    id: "wh-1",
    userId: "user-1",
    url: "https://example.com/hook",
    secret: "super-secret-key-16",
    events: ["transaction.completed", "transaction.failed"],
    filters: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("parseWebhookFilters()", () => {
  it("returns null for undefined/null/empty object", () => {
    expect(parseWebhookFilters(undefined)).toBeNull();
    expect(parseWebhookFilters(null)).toBeNull();
    expect(parseWebhookFilters({})).toBeNull();
  });

  it("accepts amount_min, currency, provider, status", () => {
    expect(
      parseWebhookFilters({
        amount_min: 100,
        currency: "USD",
        provider: "mtn",
        status: "completed",
      }),
    ).toEqual({
      amount_min: 100,
      currency: "USD",
      provider: "mtn",
      status: "completed",
    });
  });

  it("rejects unknown filter keys", () => {
    expect(() => parseWebhookFilters({ foo: "bar" })).toThrow(/Unknown filter/);
  });

  it("rejects negative amount_min", () => {
    expect(() => parseWebhookFilters({ amount_min: -1 })).toThrow(/amount_min/);
  });
});

describe("matchesWebhookFilters() — AND logic", () => {
  it("matches when filters are null/empty (backward compatible)", () => {
    expect(matchesWebhookFilters(null, basePayload)).toBe(true);
    expect(matchesWebhookFilters({}, basePayload)).toBe(true);
    expect(matchesWebhookFilters(undefined, basePayload)).toBe(true);
  });

  it("matches amount_min when amount is high enough", () => {
    expect(matchesWebhookFilters({ amount_min: 100 }, basePayload)).toBe(true);
    expect(matchesWebhookFilters({ amount_min: 200 }, basePayload)).toBe(false);
  });

  it("matches currency case-insensitively", () => {
    expect(matchesWebhookFilters({ currency: "usd" }, basePayload)).toBe(true);
    expect(matchesWebhookFilters({ currency: "EUR" }, basePayload)).toBe(false);
  });

  it("matches provider case-insensitively", () => {
    expect(matchesWebhookFilters({ provider: "MTN" }, basePayload)).toBe(true);
    expect(matchesWebhookFilters({ provider: "airtel" }, basePayload)).toBe(
      false,
    );
  });

  it("matches status", () => {
    expect(matchesWebhookFilters({ status: "completed" }, basePayload)).toBe(
      true,
    );
    expect(matchesWebhookFilters({ status: "failed" }, basePayload)).toBe(
      false,
    );
  });

  it("requires ALL specified filters to match (AND)", () => {
    expect(
      matchesWebhookFilters(
        {
          amount_min: 100,
          currency: "USD",
          provider: "mtn",
          status: "completed",
        },
        basePayload,
      ),
    ).toBe(true);

    expect(
      matchesWebhookFilters(
        { amount_min: 200, currency: "USD", provider: "mtn" },
        basePayload,
      ),
    ).toBe(false);

    expect(
      matchesWebhookFilters(
        { amount_min: 100, provider: "orange" },
        basePayload,
      ),
    ).toBe(false);
  });

  it("reads nested data envelope fields", () => {
    const nested = {
      event: "transaction.completed",
      data: {
        amount: "50",
        currency: "XAF",
        provider: "orange",
        status: "failed",
      },
    };
    expect(
      matchesWebhookFilters({ amount_min: 40, currency: "xaf" }, nested),
    ).toBe(true);
    expect(matchesWebhookFilters({ amount_min: 60 }, nested)).toBe(false);
  });
});

describe("MerchantWebhookService.dispatchEvent() filter gate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockModel.insertDeliveryLog.mockResolvedValue({ id: "log-1" });
  });

  it("delivers to subscriptions without filters", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "ok",
    });
    mockModel.findByUserId.mockResolvedValue([makeWebhook({ filters: null })]);

    const service = new MerchantWebhookService(
      fetchImpl as unknown as typeof fetch,
    );
    await service.dispatchEvent("user-1", "transaction.completed", basePayload);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(mockModel.insertDeliveryLog).toHaveBeenCalledTimes(1);
  });

  it("skips delivery when filters do not match", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "ok",
    });
    mockModel.findByUserId.mockResolvedValue([
      makeWebhook({
        filters: { amount_min: 500, provider: "mtn" },
      }),
    ]);

    const service = new MerchantWebhookService(
      fetchImpl as unknown as typeof fetch,
    );
    await service.dispatchEvent("user-1", "transaction.completed", basePayload);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockModel.insertDeliveryLog).not.toHaveBeenCalled();
  });

  it("delivers only to matching filtered subscriptions among several", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "ok",
    });
    mockModel.findByUserId.mockResolvedValue([
      makeWebhook({
        id: "wh-match",
        url: "https://example.com/match",
        filters: { amount_min: 100, currency: "USD" },
      }),
      makeWebhook({
        id: "wh-skip",
        url: "https://example.com/skip",
        filters: { provider: "airtel" },
      }),
      makeWebhook({
        id: "wh-all",
        url: "https://example.com/all",
        filters: null,
      }),
    ]);

    const service = new MerchantWebhookService(
      fetchImpl as unknown as typeof fetch,
    );
    await service.dispatchEvent("user-1", "transaction.completed", basePayload);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const urls = fetchImpl.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(urls).toEqual(
      expect.arrayContaining([
        "https://example.com/match",
        "https://example.com/all",
      ]),
    );
    expect(urls).not.toContain("https://example.com/skip");
  });

  it("does not deliver when event type is not subscribed", async () => {
    const fetchImpl = jest.fn();
    mockModel.findByUserId.mockResolvedValue([
      makeWebhook({
        events: ["transaction.failed"],
        filters: null,
      }),
    ]);

    const service = new MerchantWebhookService(
      fetchImpl as unknown as typeof fetch,
    );
    await service.dispatchEvent("user-1", "transaction.completed", basePayload);

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
