/**
 * Tests for runWebhookHealthCheckJob
 *
 * All database and email interactions are fully mocked so these tests run
 * without a real database or SendGrid account.
 */

import {
  runWebhookHealthCheckJob,
  WebhookHealthCheckDependencies,
} from "../../src/jobs/webhookHealthCheckJob";
import { MerchantWebhook } from "../../src/models/merchantWebhook";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeWebhook(overrides: Partial<MerchantWebhook> = {}): MerchantWebhook {
  return {
    id: "wh_test_1",
    userId: "user_abc",
    url: "https://example.com/webhook",
    secret: "super-secret-key",
    events: ["transaction.completed"],
    isActive: true,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

function makeLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function makeDeps(
  overrides: Partial<{
    candidates: MerchantWebhook[];
    successRate: number | null;
    disabledWebhook: MerchantWebhook | null;
    userEmail: string | null;
  }> = {},
): Required<WebhookHealthCheckDependencies> & { _mocks: ReturnType<typeof jest.fn>[] } {
  const {
    candidates = [],
    successRate = null,
    disabledWebhook = null,
    userEmail = "admin@example.com",
  } = overrides;

  const findActiveWithSufficientHistory = jest.fn().mockResolvedValue(candidates);
  const getSuccessRate = jest.fn().mockResolvedValue(successRate);
  const disableBySystem = jest.fn().mockResolvedValue(disabledWebhook);
  const reEnable = jest.fn();
  const findById = jest.fn();
  const findByUserId = jest.fn();
  const create = jest.fn();
  const update = jest.fn();
  const del = jest.fn();
  const insertDeliveryLog = jest.fn();
  const getDeliveryLogs = jest.fn();

  const webhookModel = {
    findActiveWithSufficientHistory,
    getSuccessRate,
    disableBySystem,
    reEnable,
    findById,
    findByUserId,
    create,
    update,
    delete: del,
    insertDeliveryLog,
    getDeliveryLogs,
  } as any;

  const userFindById = jest.fn().mockResolvedValue(
    userEmail ? { id: "user_abc", email: userEmail } : null,
  );
  const userModel = { findById: userFindById } as any;

  const sendWebhookDisabledNotification = jest.fn().mockResolvedValue(undefined);
  const emailSvc = { sendWebhookDisabledNotification } as any;

  const logger = makeLogger();

  return {
    webhookModel,
    userModel,
    emailSvc,
    logger,
    _mocks: [
      findActiveWithSufficientHistory,
      getSuccessRate,
      disableBySystem,
      userFindById,
      sendWebhookDisabledNotification,
    ],
  } as any;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runWebhookHealthCheckJob", () => {
  afterEach(() => jest.clearAllMocks());

  describe("with no active webhooks", () => {
    it("returns zero-counts and does not call getSuccessRate", async () => {
      const deps = makeDeps({ candidates: [] });
      const result = await runWebhookHealthCheckJob(deps);

      expect(result.evaluated).toBe(0);
      expect(result.disabled).toBe(0);
      expect(result.notified).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(deps.webhookModel.getSuccessRate).not.toHaveBeenCalled();
    });
  });

  describe("with a healthy webhook (success rate >= 30%)", () => {
    it("evaluates the webhook but does not disable it", async () => {
      const webhook = makeWebhook();
      const deps = makeDeps({ candidates: [webhook], successRate: 0.8 });

      const result = await runWebhookHealthCheckJob(deps);

      expect(result.evaluated).toBe(1);
      expect(result.disabled).toBe(0);
      expect(result.notified).toBe(0);
      expect(deps.webhookModel.getSuccessRate).toHaveBeenCalledWith(webhook.id, 100);
      expect(deps.webhookModel.disableBySystem).not.toHaveBeenCalled();
    });

    it("handles success rate exactly at threshold (30%) — should NOT disable", async () => {
      const webhook = makeWebhook();
      const deps = makeDeps({ candidates: [webhook], successRate: 0.3 });

      const result = await runWebhookHealthCheckJob(deps);

      expect(result.disabled).toBe(0);
      expect(deps.webhookModel.disableBySystem).not.toHaveBeenCalled();
    });
  });

  describe("with a failing webhook (success rate < 30%)", () => {
    it("disables the webhook and sends an email notification", async () => {
      const webhook = makeWebhook();
      const disabledWebhook = makeWebhook({
        isActive: false,
        disabledReason: "Low success rate",
        disabledAt: new Date(),
      });
      const deps = makeDeps({
        candidates: [webhook],
        successRate: 0.1,
        disabledWebhook,
        userEmail: "org@example.com",
      });

      const result = await runWebhookHealthCheckJob(deps);

      expect(result.evaluated).toBe(1);
      expect(result.disabled).toBe(1);
      expect(result.notified).toBe(1);
      expect(result.errors).toHaveLength(0);

      expect(deps.webhookModel.disableBySystem).toHaveBeenCalledWith(
        webhook.id,
        expect.stringContaining("10.0%"),
      );
      expect(deps.emailSvc.sendWebhookDisabledNotification).toHaveBeenCalledWith(
        "org@example.com",
        expect.objectContaining({
          webhookId: webhook.id,
          webhookUrl: webhook.url,
          successRate: 0.1,
        }),
      );
    });

    it("disables with success rate just below threshold (29.9%)", async () => {
      const webhook = makeWebhook();
      const deps = makeDeps({
        candidates: [webhook],
        successRate: 0.299,
        disabledWebhook: makeWebhook({ isActive: false, disabledAt: new Date() }),
        userEmail: "org@example.com",
      });

      const result = await runWebhookHealthCheckJob(deps);

      expect(result.disabled).toBe(1);
      expect(deps.webhookModel.disableBySystem).toHaveBeenCalled();
    });

    it("disables with 0% success rate", async () => {
      const webhook = makeWebhook();
      const deps = makeDeps({
        candidates: [webhook],
        successRate: 0,
        disabledWebhook: makeWebhook({ isActive: false, disabledAt: new Date() }),
        userEmail: "org@example.com",
      });

      const result = await runWebhookHealthCheckJob(deps);

      expect(result.disabled).toBe(1);
    });

    it("skips notification when disableBySystem returns null (already disabled)", async () => {
      const webhook = makeWebhook();
      const deps = makeDeps({
        candidates: [webhook],
        successRate: 0.1,
        disabledWebhook: null, // concurrent run already disabled it
        userEmail: "org@example.com",
      });

      const result = await runWebhookHealthCheckJob(deps);

      expect(result.disabled).toBe(0);
      expect(result.notified).toBe(0);
      expect(deps.emailSvc.sendWebhookDisabledNotification).not.toHaveBeenCalled();
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("already disabled"),
        expect.any(Object),
      );
    });

    it("skips email when user has no email address", async () => {
      const webhook = makeWebhook();
      const deps = makeDeps({
        candidates: [webhook],
        successRate: 0.05,
        disabledWebhook: makeWebhook({ isActive: false, disabledAt: new Date() }),
        userEmail: null, // no email on user
      });

      const result = await runWebhookHealthCheckJob(deps);

      expect(result.disabled).toBe(1);
      expect(result.notified).toBe(0);
      expect(deps.emailSvc.sendWebhookDisabledNotification).not.toHaveBeenCalled();
    });

    it("does not count notification failure as a job error", async () => {
      const webhook = makeWebhook();
      const disabledWebhook = makeWebhook({ isActive: false, disabledAt: new Date() });
      const deps = makeDeps({
        candidates: [webhook],
        successRate: 0.1,
        disabledWebhook,
        userEmail: "org@example.com",
      });
      // Notification throws
      deps.emailSvc.sendWebhookDisabledNotification.mockRejectedValue(
        new Error("SendGrid unavailable"),
      );

      const result = await runWebhookHealthCheckJob(deps);

      // Webhook was disabled successfully
      expect(result.disabled).toBe(1);
      // Notification failure is logged but NOT added to errors array
      expect(result.errors).toHaveLength(0);
      expect(result.notified).toBe(0);
      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.stringContaining("notification"),
        expect.any(Object),
      );
    });
  });

  describe("with null successRate (no delivery logs)", () => {
    it("skips the webhook without disabling", async () => {
      const webhook = makeWebhook();
      const deps = makeDeps({ candidates: [webhook], successRate: null });

      const result = await runWebhookHealthCheckJob(deps);

      expect(result.evaluated).toBe(1);
      expect(result.disabled).toBe(0);
      expect(deps.webhookModel.disableBySystem).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("records error when getSuccessRate throws", async () => {
      const webhook = makeWebhook();
      const deps = makeDeps({ candidates: [webhook] });
      deps.webhookModel.getSuccessRate.mockRejectedValue(new Error("DB timeout"));

      const result = await runWebhookHealthCheckJob(deps);

      expect(result.evaluated).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toEqual({
        webhookId: webhook.id,
        error: "DB timeout",
      });
      expect(result.disabled).toBe(0);
    });

    it("records error when disableBySystem throws", async () => {
      const webhook = makeWebhook();
      const deps = makeDeps({ candidates: [webhook], successRate: 0.1 });
      deps.webhookModel.disableBySystem.mockRejectedValue(new Error("Update failed"));

      const result = await runWebhookHealthCheckJob(deps);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toBe("Update failed");
      expect(result.disabled).toBe(0);
    });

    it("returns early when findActiveWithSufficientHistory throws", async () => {
      const deps = makeDeps({ candidates: [] });
      deps.webhookModel.findActiveWithSufficientHistory.mockRejectedValue(
        new Error("Connection lost"),
      );

      const result = await runWebhookHealthCheckJob(deps);

      expect(result.evaluated).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.stringContaining("fetch webhook candidates"),
        expect.any(Object),
      );
    });

    it("continues processing remaining webhooks after one fails", async () => {
      const wh1 = makeWebhook({ id: "wh_1" });
      const wh2 = makeWebhook({ id: "wh_2" });
      const deps = makeDeps({
        candidates: [wh1, wh2],
        disabledWebhook: makeWebhook({ isActive: false, disabledAt: new Date() }),
        userEmail: "org@example.com",
      });

      // First webhook: getSuccessRate throws
      deps.webhookModel.getSuccessRate
        .mockRejectedValueOnce(new Error("Timeout on wh_1"))
        .mockResolvedValueOnce(0.1); // second webhook is failing

      const result = await runWebhookHealthCheckJob(deps);

      expect(result.evaluated).toBe(2);
      expect(result.errors).toHaveLength(1);
      expect(result.disabled).toBe(1); // second was disabled
    });
  });

  describe("multiple webhooks", () => {
    it("disables only failing webhooks and leaves healthy ones active", async () => {
      const healthy = makeWebhook({ id: "wh_healthy", url: "https://good.example.com/wh" });
      const failing = makeWebhook({ id: "wh_failing", url: "https://bad.example.com/wh" });

      const deps = makeDeps({
        candidates: [healthy, failing],
        disabledWebhook: makeWebhook({ isActive: false, disabledAt: new Date() }),
        userEmail: "org@example.com",
      });

      deps.webhookModel.getSuccessRate
        .mockResolvedValueOnce(0.95) // healthy
        .mockResolvedValueOnce(0.1); // failing

      const result = await runWebhookHealthCheckJob(deps);

      expect(result.evaluated).toBe(2);
      expect(result.disabled).toBe(1);
      expect(result.notified).toBe(1);
      expect(deps.webhookModel.disableBySystem).toHaveBeenCalledTimes(1);
      expect(deps.webhookModel.disableBySystem).toHaveBeenCalledWith(
        "wh_failing",
        expect.any(String),
      );
    });
  });
});
