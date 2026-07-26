/**
 * Webhook Health Check Job
 *
 * Runs hourly (via BullMQ repeat schedule). For each active merchant webhook
 * endpoint that has at least MIN_DELIVERY_WINDOW delivery log entries:
 *
 *   1. Calculates the success rate over the last DELIVERY_WINDOW deliveries.
 *   2. If success rate < SUCCESS_RATE_THRESHOLD, disables the endpoint and
 *      sends an email notification to the owning user's email address.
 *
 * Configuration (env vars):
 *   WEBHOOK_HEALTH_DELIVERY_WINDOW      – number of past deliveries to evaluate (default: 100)
 *   WEBHOOK_HEALTH_SUCCESS_THRESHOLD    – minimum success rate 0–1            (default: 0.30)
 *   WEBHOOK_HEALTH_MIN_DELIVERIES       – min deliveries needed to evaluate   (default: 10)
 */

import { MerchantWebhookModel, MerchantWebhook } from "../models/merchantWebhook";
import { UserModel } from "../models/users";
import { emailService } from "../services/email";

// ─── Configuration ────────────────────────────────────────────────────────────

const DELIVERY_WINDOW = (() => {
  const v = parseInt(process.env.WEBHOOK_HEALTH_DELIVERY_WINDOW || "100", 10);
  return Number.isFinite(v) && v > 0 ? v : 100;
})();

const SUCCESS_RATE_THRESHOLD = (() => {
  const v = parseFloat(process.env.WEBHOOK_HEALTH_SUCCESS_THRESHOLD || "0.30");
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.3;
})();

const MIN_DELIVERIES = (() => {
  const v = parseInt(process.env.WEBHOOK_HEALTH_MIN_DELIVERIES || "10", 10);
  return Number.isFinite(v) && v > 0 ? v : 10;
})();

// ─── Interfaces for dependency injection ─────────────────────────────────────

export interface WebhookHealthCheckDependencies {
  webhookModel?: MerchantWebhookModel;
  userModel?: UserModel;
  emailSvc?: typeof emailService;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export interface WebhookHealthCheckResult {
  evaluated: number;
  disabled: number;
  notified: number;
  errors: Array<{ webhookId: string; error: string }>;
}

// ─── Structured logger ────────────────────────────────────────────────────────

type LogLevel = "info" | "warn" | "error";

function makeLogger(prefix: string) {
  return {
    info: (msg: string, meta: Record<string, unknown> = {}) => {
      console.log(
        JSON.stringify({ timestamp: new Date().toISOString(), level: "info", service: prefix, message: msg, ...meta }),
      );
    },
    warn: (msg: string, meta: Record<string, unknown> = {}) => {
      console.warn(
        JSON.stringify({ timestamp: new Date().toISOString(), level: "warn", service: prefix, message: msg, ...meta }),
      );
    },
    error: (msg: string, meta: Record<string, unknown> = {}) => {
      console.error(
        JSON.stringify({ timestamp: new Date().toISOString(), level: "error", service: prefix, message: msg, ...meta }),
      );
    },
  };
}

// ─── Main job function ────────────────────────────────────────────────────────

/**
 * Evaluates all active webhook endpoints and disables those with a success
 * rate below the configured threshold over the last DELIVERY_WINDOW attempts.
 */
export async function runWebhookHealthCheckJob(
  deps: WebhookHealthCheckDependencies = {},
): Promise<WebhookHealthCheckResult> {
  const webhookModel = deps.webhookModel ?? new MerchantWebhookModel();
  const userModel = deps.userModel ?? new UserModel();
  const emailSvc = deps.emailSvc ?? emailService;
  const log = deps.logger ?? makeLogger("webhook-health-check");

  const result: WebhookHealthCheckResult = {
    evaluated: 0,
    disabled: 0,
    notified: 0,
    errors: [],
  };

  log.info("Webhook health check starting", {
    deliveryWindow: DELIVERY_WINDOW,
    successThreshold: SUCCESS_RATE_THRESHOLD,
    minDeliveries: MIN_DELIVERIES,
  });

  // Fetch active webhooks that have sufficient delivery history
  let candidates: MerchantWebhook[];
  try {
    candidates = await webhookModel.findActiveWithSufficientHistory(MIN_DELIVERIES);
  } catch (err) {
    log.error("Failed to fetch webhook candidates", {
      reason: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  log.info(`Evaluating ${candidates.length} webhook(s)`);

  for (const webhook of candidates) {
    result.evaluated += 1;

    let successRate: number | null;
    try {
      successRate = await webhookModel.getSuccessRate(webhook.id, DELIVERY_WINDOW);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error("Failed to compute success rate", { webhookId: webhook.id, reason: error });
      result.errors.push({ webhookId: webhook.id, error });
      continue;
    }

    if (successRate === null) {
      // No delivery logs yet — skip
      log.info("Skipping webhook — no delivery logs", { webhookId: webhook.id });
      continue;
    }

    log.info("Webhook success rate computed", {
      webhookId: webhook.id,
      url: webhook.url,
      successRate: (successRate * 100).toFixed(1) + "%",
      threshold: (SUCCESS_RATE_THRESHOLD * 100).toFixed(1) + "%",
      belowThreshold: successRate < SUCCESS_RATE_THRESHOLD,
    });

    if (successRate >= SUCCESS_RATE_THRESHOLD) {
      continue; // Healthy — nothing to do
    }

    // ── Disable the webhook ──────────────────────────────────────────────────
    const disabledReason =
      `Automatically disabled: success rate ${(successRate * 100).toFixed(1)}% ` +
      `over last ${DELIVERY_WINDOW} deliveries is below the ${(SUCCESS_RATE_THRESHOLD * 100).toFixed(0)}% threshold.`;

    let disabled: MerchantWebhook | null;
    try {
      disabled = await webhookModel.disableBySystem(webhook.id, disabledReason);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error("Failed to disable webhook", { webhookId: webhook.id, reason: error });
      result.errors.push({ webhookId: webhook.id, error });
      continue;
    }

    if (!disabled) {
      // Was already disabled by a concurrent run — not an error
      log.warn("Webhook was already disabled — skipping notification", {
        webhookId: webhook.id,
      });
      continue;
    }

    result.disabled += 1;
    log.warn("Webhook disabled by health check", {
      webhookId: webhook.id,
      url: webhook.url,
      successRate: (successRate * 100).toFixed(1) + "%",
    });

    // ── Notify the owning user ───────────────────────────────────────────────
    try {
      const user = await userModel.findById(webhook.userId);
      const email = user?.email;

      if (!email) {
        log.warn("Webhook owner has no email — notification skipped", {
          webhookId: webhook.id,
          userId: webhook.userId,
        });
        continue;
      }

      await emailSvc.sendWebhookDisabledNotification(email, {
        webhookId: webhook.id,
        webhookUrl: webhook.url,
        successRate,
        disabledAt: disabled.disabledAt ?? new Date(),
      });

      result.notified += 1;
      log.info("Webhook disabled notification sent", {
        webhookId: webhook.id,
        email: email.replace(/(?<=.{3}).(?=.*@)/g, "*"), // partial mask for logs
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // Don't count notification failures as job failures — webhook was disabled successfully
      log.error("Failed to send webhook disabled notification", {
        webhookId: webhook.id,
        reason: error,
      });
    }
  }

  log.info("Webhook health check complete", {
    evaluated: result.evaluated,
    disabled: result.disabled,
    notified: result.notified,
    errors: result.errors.length,
  });

  return result;
}
