/**
 * Merchant Onboarding Progress Tracking Service
 *
 * Scores merchant onboarding completion (0–100 %), tracks pending
 * requirements, fires progress webhooks for external integrations, and
 * exposes analytics about the onboarding funnel.
 *
 * Issue #410 — Merchant Onboarding Progress Tracking
 */

import { queryRead } from "../config/database";
import { MerchantModel, type Merchant } from "../models/merchant";
import { MerchantWebhookModel } from "../models/merchantWebhook";
import { createHmac } from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OnboardingStep =
  | "profile_complete"
  | "email_verified"
  | "invitation_accepted"
  | "kyc_started"
  | "kyc_verified"
  | "bank_account_linked"
  | "first_transaction";

export interface OnboardingRequirement {
  step: OnboardingStep;
  label: string;
  completed: boolean;
  /** ISO timestamp of when this step was completed, if known. */
  completedAt: string | null;
  /** Whether this step blocks activation. */
  required: boolean;
}

export interface OnboardingProgress {
  merchantId: string;
  scorePercent: number;
  requirements: OnboardingRequirement[];
  isActivationReady: boolean;
  completedSteps: OnboardingStep[];
  pendingSteps: OnboardingStep[];
  lastUpdatedAt: string;
}

export interface OnboardingAnalyticsSummary {
  totalMerchants: number;
  fullyOnboarded: number;
  kycPending: number;
  invitationPending: number;
  averageScorePercent: number;
  stageBreakdown: Record<OnboardingStep | "unknown", number>;
}

export interface OnboardingWebhookEvent {
  eventType: "onboarding.step_completed" | "onboarding.completed" | "onboarding.stalled";
  merchantId: string;
  step?: OnboardingStep;
  scorePercent: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Step definitions
// ---------------------------------------------------------------------------

/** Required steps — all must be complete before activation. */
const REQUIRED_STEPS: OnboardingStep[] = [
  "profile_complete",
  "invitation_accepted",
  "kyc_verified",
];

/** All steps in priority order (required first, then optional). */
const ALL_STEPS: OnboardingStep[] = [
  "profile_complete",
  "email_verified",
  "invitation_accepted",
  "kyc_started",
  "kyc_verified",
  "bank_account_linked",
  "first_transaction",
];

const STEP_LABELS: Record<OnboardingStep, string> = {
  profile_complete: "Complete business profile",
  email_verified: "Verify email address",
  invitation_accepted: "Accept onboarding invitation",
  kyc_started: "Start KYC verification",
  kyc_verified: "Complete KYC verification",
  bank_account_linked: "Link bank / settlement account",
  first_transaction: "Process first test transaction",
};

// ---------------------------------------------------------------------------
// Progress calculator
// ---------------------------------------------------------------------------

function buildRequirements(merchant: Merchant): OnboardingRequirement[] {
  const hasProfile = Boolean(
    merchant.businessName && merchant.businessType && merchant.taxId,
  );
  const kycStatus = merchant.kycStatus;

  return ALL_STEPS.map((step): OnboardingRequirement => {
    let completed = false;
    let completedAt: string | null = null;

    switch (step) {
      case "profile_complete":
        completed = hasProfile;
        break;
      case "email_verified":
        // Email is considered verified once the merchant record exists
        completed = true;
        break;
      case "invitation_accepted":
        completed = Boolean(merchant.invitationAcceptedAt);
        completedAt = merchant.invitationAcceptedAt
          ? new Date(merchant.invitationAcceptedAt).toISOString()
          : null;
        break;
      case "kyc_started":
        completed =
          kycStatus === "in_progress" ||
          kycStatus === "verified";
        break;
      case "kyc_verified":
        completed = kycStatus === "verified";
        break;
      case "bank_account_linked":
        completed = Boolean(merchant.metadata?.bankAccountLinked);
        completedAt = merchant.metadata?.bankAccountLinkedAt
          ? String(merchant.metadata.bankAccountLinkedAt)
          : null;
        break;
      case "first_transaction":
        completed = Boolean(merchant.metadata?.firstTransactionAt);
        completedAt = merchant.metadata?.firstTransactionAt
          ? String(merchant.metadata.firstTransactionAt)
          : null;
        break;
    }

    return {
      step,
      label: STEP_LABELS[step],
      completed,
      completedAt,
      required: REQUIRED_STEPS.includes(step),
    };
  });
}

function calculateScore(requirements: OnboardingRequirement[]): number {
  if (requirements.length === 0) return 0;
  const completed = requirements.filter((r) => r.completed).length;
  return Math.round((completed / requirements.length) * 100);
}

// ---------------------------------------------------------------------------
// Webhook helpers
// ---------------------------------------------------------------------------

async function fireOnboardingWebhook(
  merchantId: string,
  event: OnboardingWebhookEvent,
): Promise<void> {
  try {
    const webhookModel = new MerchantWebhookModel();
    // findByUserId treats merchantId as the user identifier here
    const allWebhooks = await webhookModel.findByUserId(merchantId);
    const webhooks = allWebhooks.filter((wh) => wh.isActive);

    await Promise.allSettled(
      webhooks.map(async (wh) => {
        const sig = createHmac("sha256", wh.secret)
          .update(JSON.stringify(event))
          .digest("hex");

        const resp = await fetch(wh.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-ProxyPay-Signature": `sha256=${sig}`,
            "X-ProxyPay-Event": event.eventType,
          },
          body: JSON.stringify(event),
        });

        if (!resp.ok) {
          console.warn(
            `[merchant-onboarding] Webhook ${wh.id} responded ${resp.status}`,
          );
        }
      }),
    );
  } catch (err) {
    console.warn(
      `[merchant-onboarding] Webhook delivery error for ${merchantId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// DB helpers for analytics
// ---------------------------------------------------------------------------

async function fetchOnboardingAnalytics(): Promise<OnboardingAnalyticsSummary> {
  const totalsResult = await queryRead<{
    total: string;
    fully_onboarded: string;
    kyc_pending: string;
    invitation_pending: string;
  }>(
    `SELECT
       COUNT(*)                                                               AS total,
       COUNT(*) FILTER (WHERE status = 'active' AND kyc_status = 'verified') AS fully_onboarded,
       COUNT(*) FILTER (WHERE kyc_status IN ('not_started', 'in_progress'))  AS kyc_pending,
       COUNT(*) FILTER (WHERE invitation_accepted_at IS NULL)                AS invitation_pending
     FROM merchants`,
  );

  const row = totalsResult.rows[0];
  const total = parseInt(row?.total ?? "0", 10);
  const fullyOnboarded = parseInt(row?.fully_onboarded ?? "0", 10);
  const kycPending = parseInt(row?.kyc_pending ?? "0", 10);
  const invitationPending = parseInt(row?.invitation_pending ?? "0", 10);

  return {
    totalMerchants: total,
    fullyOnboarded,
    kycPending,
    invitationPending,
    averageScorePercent: total > 0 ? Math.round((fullyOnboarded / total) * 100) : 0,
    stageBreakdown: {
      profile_complete: total,
      email_verified: total,
      invitation_accepted: total - invitationPending,
      kyc_started: total - kycPending,
      kyc_verified: fullyOnboarded,
      bank_account_linked: 0,
      first_transaction: 0,
      unknown: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Main service
// ---------------------------------------------------------------------------

export class MerchantOnboardingService {
  private merchantModel: MerchantModel;

  constructor() {
    this.merchantModel = new MerchantModel();
  }

  /**
   * Calculate the current onboarding progress for a merchant.
   */
  async getProgress(merchantId: string): Promise<OnboardingProgress> {
    const merchant = await this.merchantModel.findById(merchantId);
    if (!merchant) {
      throw new Error(`Merchant not found: ${merchantId}`);
    }

    const requirements = buildRequirements(merchant);
    const scorePercent = calculateScore(requirements);
    const isActivationReady = REQUIRED_STEPS.every(
      (step) => requirements.find((r) => r.step === step)?.completed,
    );

    return {
      merchantId,
      scorePercent,
      requirements,
      isActivationReady,
      completedSteps: requirements
        .filter((r) => r.completed)
        .map((r) => r.step),
      pendingSteps: requirements
        .filter((r) => !r.completed)
        .map((r) => r.step),
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  /**
   * Mark a specific onboarding step as completed and persist metadata.
   * Fires progress webhooks automatically.
   */
  async completeStep(
    merchantId: string,
    step: OnboardingStep,
    extraMetadata: Record<string, unknown> = {},
  ): Promise<OnboardingProgress> {
    const merchant = await this.merchantModel.findById(merchantId);
    if (!merchant) {
      throw new Error(`Merchant not found: ${merchantId}`);
    }

    const updatedMetadata: Record<string, unknown> = {
      ...merchant.metadata,
      ...extraMetadata,
    };

    // Persist step-specific flags into merchant metadata
    if (step === "bank_account_linked") {
      updatedMetadata.bankAccountLinked = true;
      updatedMetadata.bankAccountLinkedAt = new Date().toISOString();
    }
    if (step === "first_transaction") {
      updatedMetadata.firstTransactionAt = new Date().toISOString();
    }

    await this.merchantModel.update(merchantId, { metadata: updatedMetadata });

    const progress = await this.getProgress(merchantId);

    // Fire webhook event
    const event: OnboardingWebhookEvent = {
      eventType: progress.isActivationReady
        ? "onboarding.completed"
        : "onboarding.step_completed",
      merchantId,
      step,
      scorePercent: progress.scorePercent,
      timestamp: new Date().toISOString(),
    };

    await fireOnboardingWebhook(merchantId, event);

    return progress;
  }

  /**
   * Return aggregate analytics across all merchants.
   */
  async getAnalytics(): Promise<OnboardingAnalyticsSummary> {
    return fetchOnboardingAnalytics();
  }
}

export const merchantOnboardingService = new MerchantOnboardingService();
