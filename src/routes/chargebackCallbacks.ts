import { Router, Request, Response } from "express";
import { z } from "zod";
import { chargebackService, ChargebackNotification } from "../services/chargebackService";
import { createError } from "../middleware/errorHandler";
import { ERROR_CODES } from "../constants/errorCodes";
import logger from "../utils/logger";

const router = Router();

/**
 * POST /callbacks/chargeback
 *
 * Receives incoming chargeback notifications from mobile money operators.
 * Validates the payload, processes the chargeback atomically, and returns
 * the result.
 */
const chargebackCallbackSchema = z.object({
  chargeback_reference: z.string().min(1, "chargeback_reference is required"),
  transaction_reference: z.string().min(1, "transaction_reference is required"),
  reason: z.string().optional(),
  amount: z.number().positive().optional(),
  currency: z.string().length(3).optional(),
  operator_callback_ref: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

router.post("/callbacks/chargeback", async (req: Request, res: Response) => {
  try {
    // Validate the incoming payload
    const parseResult = chargebackCallbackSchema.safeParse(req.body);

    if (!parseResult.success) {
      const errors = parseResult.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      );
      throw createError(ERROR_CODES.INVALID_INPUT, "Invalid chargeback payload", {
        error: "Validation Error",
        message: `Chargeback payload validation failed: ${errors.join("; ")}`,
      });
    }

    const notification: ChargebackNotification = parseResult.data;

    logger.info(
      {
        chargebackReference: notification.chargeback_reference,
        transactionReference: notification.transaction_reference,
      },
      "[chargeback-callback] Processing chargeback notification",
    );

    const result = await chargebackService.processChargeback(notification);

    res.status(200).json({
      status: "accepted",
      chargeback_id: result.chargebackId,
      transaction_id: result.transactionId,
      message: result.message,
    });
  } catch (error: any) {
    // Map known errors to appropriate HTTP status codes
    if (
      error.message?.includes("Transaction not found")
    ) {
      res.status(404).json({
        status: "error",
        error: "Not Found",
        message: error.message,
      });
      return;
    }

    if (
      error.message?.includes("not eligible for chargeback")
    ) {
      res.status(409).json({
        status: "error",
        error: "Conflict",
        message: error.message,
      });
      return;
    }

    // Re-throw if it's our structured error
    if (error.statusCode) {
      res.status(error.statusCode).json({
        status: "error",
        error: error.error || "Bad Request",
        message: error.message,
      });
      return;
    }

    // Unexpected error
    logger.error(
      { err: error, body: req.body },
      "[chargeback-callback] Unexpected error processing chargeback",
    );

    res.status(500).json({
      status: "error",
      error: "Internal Server Error",
      message: "An unexpected error occurred processing the chargeback",
    });
  }
});

export default router;
