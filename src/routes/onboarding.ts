import { Router } from "express";
import { OnboardingController } from "../controllers/onboardingController";
import { requireAuth } from "../middleware/auth";
import { validateRequest } from "../middleware/validation";
import { step1Schema, step2Schema, step3Schema } from "../schemas/onboarding";

export const onboardingRoutes = Router();

/**
 * POST /api/onboarding/account
 * Step 1: Create user account and organization (public endpoint)
 */
onboardingRoutes.post(
  "/account",
  validateRequest(step1Schema),
  OnboardingController.createAccount,
);

/**
 * PATCH /api/onboarding/business
 * Step 2: Update business information (authenticated)
 */
onboardingRoutes.patch(
  "/business",
  requireAuth,
  validateRequest(step2Schema),
  OnboardingController.updateBusinessInfo,
);

/**
 * PATCH /api/onboarding/use-case
 * Step 3: Set use cases (authenticated)
 */
onboardingRoutes.patch(
  "/use-case",
  requireAuth,
  validateRequest(step3Schema),
  OnboardingController.setUseCases,
);

/**
 * GET /api/onboarding/status
 * Get current step and completion status (authenticated)
 */
onboardingRoutes.get(
  "/status",
  requireAuth,
  OnboardingController.getStatus,
);
