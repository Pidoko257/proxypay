/**
 * Timeout Statistics Routes
 *
 * Provides a read-only dashboard API for timeout monitoring.
 *
 * All endpoints require authentication.  The `/policies` endpoint is
 * publicly readable to let client applications adapt their retry logic.
 *
 * Base path: /api/timeouts
 *
 *   GET /api/timeouts/stats          — live in-process stats (last ~1 000 events)
 *   GET /api/timeouts/stats/history  — DB-backed aggregates (query param: hours=24)
 *   GET /api/timeouts/policies       — all configured timeout policies
 *   POST /api/timeouts/recover       — manually trigger recovery for a transaction
 */

import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { timeoutService } from "../services/timeoutService";
import {
  transactionRecoveryService,
  RecoveryContext,
} from "../services/transactionRecovery";
import { getAllOperationPolicies } from "../middleware/timeout";
import { OperationType } from "../utils/timeoutPolicies";

export const timeoutRoutes = Router();

// ---------------------------------------------------------------------------
// GET /api/timeouts/stats
// ---------------------------------------------------------------------------

/**
 * @route   GET /api/timeouts/stats
 * @desc    Returns live in-memory timeout statistics (last ~1 000 events)
 * @access  Private (authenticated users)
 */
timeoutRoutes.get("/stats", requireAuth, async (_req: Request, res: Response) => {
  try {
    const stats = timeoutService.getStats();
    return res.json({
      success: true,
      data: stats,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: "Failed to retrieve timeout statistics",
    });
  }
});

// ---------------------------------------------------------------------------
// GET /api/timeouts/stats/history
// ---------------------------------------------------------------------------

/**
 * @route   GET /api/timeouts/stats/history
 * @desc    Returns historical timeout aggregates from the database
 * @query   hours — number of hours to look back (default: 24, max: 720)
 * @access  Private (authenticated users)
 */
timeoutRoutes.get(
  "/stats/history",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const raw = parseInt((req.query.hours as string) ?? "24", 10);
      const hours = isNaN(raw) ? 24 : Math.min(Math.max(1, raw), 720);
      const history = await timeoutService.getHistoricalStats(hours);
      return res.json({
        success: true,
        data: history,
        queryWindowHours: hours,
        generatedAt: new Date().toISOString(),
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: "Failed to retrieve historical timeout statistics",
      });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/timeouts/policies
// ---------------------------------------------------------------------------

/**
 * @route   GET /api/timeouts/policies
 * @desc    Returns all configured timeout policies
 * @access  Public (no auth required — clients need this to set their own timeouts)
 */
timeoutRoutes.get("/policies", (_req: Request, res: Response) => {
  try {
    const policies = getAllOperationPolicies();
    return res.json({
      success: true,
      data: policies,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: "Failed to retrieve timeout policies",
    });
  }
});

// ---------------------------------------------------------------------------
// POST /api/timeouts/recover
// ---------------------------------------------------------------------------

/**
 * @route   POST /api/timeouts/recover
 * @desc    Manually triggers partial recovery for a timed-out transaction
 * @body    {
 *            transactionId?: string,
 *            referenceId?: string,
 *            provider?: string,
 *            stellarTxHash?: string,
 *            operationType?: OperationType
 *          }
 * @access  Private (authenticated users)
 */
timeoutRoutes.post(
  "/recover",
  requireAuth,
  async (req: Request, res: Response) => {
    const {
      transactionId,
      referenceId,
      provider,
      stellarTxHash,
      operationType,
      elapsedMs,
    } = req.body as {
      transactionId?: string;
      referenceId?: string;
      provider?: string;
      stellarTxHash?: string;
      operationType?: OperationType;
      elapsedMs?: number;
    };

    // Validate: at least one identifier required
    if (!transactionId && !referenceId && !stellarTxHash) {
      return res.status(400).json({
        success: false,
        error:
          "At least one of transactionId, referenceId, or stellarTxHash is required",
      });
    }

    const ctx: RecoveryContext = {
      operationType: operationType ?? OperationType.DEFAULT,
      transactionId,
      referenceId,
      provider,
      stellarTxHash,
      elapsedMs: elapsedMs ?? 0,
      requestId: (req as any).id,
      attemptedAt: new Date().toISOString(),
    };

    try {
      const result = await transactionRecoveryService.attemptRecovery(ctx);
      return res.json({
        success: true,
        data: result,
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: "Recovery attempt failed",
      });
    }
  },
);
