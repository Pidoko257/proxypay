import { Router, Request, Response } from "express";
import { securityAnomalyService } from "../services/securityAnomalyService";
import { createError } from "../middleware/errorHandler";
import { ERROR_CODES } from "../constants/errorCodes";

const router = Router();

router.get("/approve", async (req: Request, res: Response) => {
  const { token } = req.query;

  if (!token || typeof token !== "string") {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid approval token", {
      error: "invalid_request",
    });
  }

  const validation = await securityAnomalyService.validateApprovalToken(token);
  if (!validation.valid) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid or expired token", {
      error: "invalid_token",
    });
  }

  const approved = await securityAnomalyService.approveAnomaly(token);
  if (!approved) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Failed to approve anomaly", {
      error: "invalid_token",
    });
  }

  res.json({ status: "approved", message: "Anomaly approved successfully" });
});

router.get("/revoke", async (req: Request, res: Response) => {
  const { token } = req.query;

  if (!token || typeof token !== "string") {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid revoke token", {
      error: "invalid_request",
    });
  }

  const validation = await securityAnomalyService.validateApprovalToken(token);
  if (!validation.valid) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid or expired token", {
      error: "invalid_token",
    });
  }

  securityAnomalyService.approveAnomaly(token);
  res.json({ status: "revoked", message: "Session revoked successfully" });
});

router.get("/", async (req: Request, res: Response) => {
  const userId = req.jwtUser?.userId;
  if (!userId) {
    throw createError(ERROR_CODES.UNAUTHORIZED, "Authentication required", {
      error: "unauthorized",
    });
  }

  const events = await securityAnomalyService.getSecurityEvents(userId);
  res.json({ events });
});

export default router;