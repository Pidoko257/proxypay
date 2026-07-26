import { Request, Response } from "express";
import { OnboardingService } from "../services/onboardingService";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

const onboardingService = new OnboardingService();

export class OnboardingController {
  /**
   * POST /api/onboarding/account
   * Step 1: Create user account and organization
   */
  static async createAccount(req: Request, res: Response) {
    try {
      const result = await onboardingService.createAccount(req.body);
      return res.status(201).json({
        message: "Account created successfully",
        data: result,
      });
    } catch (error) {
      if (error instanceof Error) {
        throw createError(
          ERROR_CODES.INTERNAL_ERROR,
          "Failed to create account",
          { error: error.message },
        );
      }
      throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to create account");
    }
  }

  /**
   * PATCH /api/onboarding/business
   * Step 2: Update business information
   */
  static async updateBusinessInfo(req: Request, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized", {
          error: "User not authenticated",
        });
      }

      const result = await onboardingService.updateBusinessInfo(userId, req.body);
      return res.status(200).json({
        message: "Business information updated successfully",
        data: result,
      });
    } catch (error) {
      if (error instanceof Error) {
        throw createError(
          ERROR_CODES.INTERNAL_ERROR,
          "Failed to update business info",
          { error: error.message },
        );
      }
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to update business info",
      );
    }
  }

  /**
   * PATCH /api/onboarding/use-case
   * Step 3: Set use cases
   */
  static async setUseCases(req: Request, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized", {
          error: "User not authenticated",
        });
      }

      const result = await onboardingService.setUseCases(userId, req.body);
      return res.status(200).json({
        message: "Use cases updated successfully",
        data: result,
      });
    } catch (error) {
      if (error instanceof Error) {
        throw createError(
          ERROR_CODES.INTERNAL_ERROR,
          "Failed to update use cases",
          { error: error.message },
        );
      }
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to update use cases",
      );
    }
  }

  /**
   * GET /api/onboarding/status
   * Returns current step and completion status
   */
  static async getStatus(req: Request, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        throw createError(ERROR_CODES.UNAUTHORIZED, "Unauthorized", {
          error: "User not authenticated",
        });
      }

      const result = await onboardingService.getStatus(userId);
      return res.status(200).json({ data: result });
    } catch (error) {
      if (error instanceof Error) {
        throw createError(
          ERROR_CODES.INTERNAL_ERROR,
          "Failed to fetch onboarding status",
          { error: error.message },
        );
      }
      throw createError(
        ERROR_CODES.INTERNAL_ERROR,
        "Failed to fetch onboarding status",
      );
    }
  }
}
