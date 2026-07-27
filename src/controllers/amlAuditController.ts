import { Request, Response } from "express";
import { AMLAlertModel, AMLAlertFilter } from "../models/amlAlert";
import { TransactionModel } from "../models/transaction";
import { UserModel } from "../models/users";
import { amlService } from "../services/aml";

const amlAlertModel = new AMLAlertModel();
const transactionModel = new TransactionModel();
const userModel = new UserModel();

/**
 * List AML alerts with filtering and pagination
 * GET /api/audit/aml/alerts
 * Query params: status, userId, severity, startDate, endDate, limit, offset
 */
export const listAmlAlertsForAudit = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const {
      status,
      userId,
      severity,
      startDate,
      endDate,
      limit,
      offset,
      before,
      after,
    } = req.query;

    const validStatuses = ["pending_review", "reviewed", "dismissed"] as const;
    const validSeverities = ["medium", "high"] as const;

    const filter: AMLAlertFilter = {};

    if (status && typeof status === "string") {
      if (!validStatuses.includes(status as any)) {
        res.status(400).json({
          error: "Invalid status",
          message: "Status must be one of: pending_review, reviewed, dismissed",
        });
        return;
      }
      filter.status = status as any;
    }

    if (userId && typeof userId === "string") {
      filter.userId = userId;
    }

    if (severity && typeof severity === "string") {
      if (!validSeverities.includes(severity as any)) {
        res.status(400).json({
          error: "Invalid severity",
          message: "Severity must be one of: medium, high",
        });
        return;
      }
      filter.severity = severity as any;
    }

    if (startDate && typeof startDate === "string") {
      const parsed = new Date(startDate);
      if (isNaN(parsed.getTime())) {
        res.status(400).json({ error: "Invalid startDate format" });
        return;
      }
      filter.startDate = parsed;
    }

    if (endDate && typeof endDate === "string") {
      const parsed = new Date(endDate);
      if (isNaN(parsed.getTime())) {
        res.status(400).json({ error: "Invalid endDate format" });
        return;
      }
      filter.endDate = parsed;
    }

    if (limit && typeof limit === "string") {
      const parsedLimit = parseInt(limit, 10);
      if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
        res.status(400).json({
          error: "Invalid limit",
          message: "Limit must be between 1 and 100",
        });
        return;
      }
      filter.limit = parsedLimit;
    }

    if (offset && typeof offset === "string") {
      const parsedOffset = parseInt(offset, 10);
      if (isNaN(parsedOffset) || parsedOffset < 0) {
        res.status(400).json({
          error: "Invalid offset",
          message: "Offset must be >= 0",
        });
        return;
      }
      filter.offset = parsedOffset;
    }

    if (before && typeof before === "string") {
      filter.before = before;
    }

    if (after && typeof after === "string") {
      filter.after = after;
    }

    const result = await amlAlertModel.list(filter);

    const limitVal = filter.limit ?? 50;
    const pagination: any = {
      total: result.total,
      limit: limitVal,
    };

    if (before || after || filter.before || filter.after) {
      pagination.before = result.alerts.length
        ? Buffer.from(`${result.alerts[0].createdAt}|${result.alerts[0].id}`).toString("base64")
        : null;
      pagination.after = result.alerts.length
        ? Buffer.from(`${result.alerts[result.alerts.length - 1].createdAt}|${result.alerts[result.alerts.length - 1].id}`).toString("base64")
        : null;
      pagination.hasMore = result.hasMore ?? false;
    } else {
      pagination.offset = filter.offset ?? 0;
      pagination.hasMore = result.hasMore ?? false;
    }

    res.json({
      data: result.alerts,
      pagination,
      summary: {
        pendingReview: result.pendingReview,
      },
    });
  } catch (error) {
    console.error("Failed to list AML alerts for audit:", error);
    res.status(500).json({ error: "Failed to list AML alerts" });
  }
};

/**
 * Get detailed AML alert with transaction and user context
 * GET /api/audit/aml/alerts/:alertId
 */
export const getAmlAlertDetails = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { alertId } = req.params;

    const alert = await amlAlertModel.findById(alertId);
    if (!alert) {
      res.status(404).json({ error: "AML alert not found" });
      return;
    }

    // Fetch related transaction
    const transaction = await transactionModel.findById(alert.transactionId);
    if (!transaction) {
      res.status(404).json({ error: "Related transaction not found" });
      return;
    }

    // Fetch user details
    const user = await userModel.findById(alert.userId);

    // Fetch review history
    const reviewHistory = await amlAlertModel.getReviewHistory(alertId);

    res.json({
      alert,
      transaction: {
        id: transaction.id,
        referenceNumber: transaction.referenceNumber,
        type: transaction.type,
        amount: transaction.amount,
        phoneNumber: transaction.phoneNumber,
        provider: transaction.provider,
        status: transaction.status,
        createdAt: transaction.createdAt,
        tags: transaction.tags,
        metadata: transaction.metadata,
      },
      user: user
        ? {
            id: user.id,
            phoneNumber: user.phoneNumber,
            kycLevel: user.kycLevel,
          }
        : null,
      reviewHistory,
    });
  } catch (error) {
    console.error("Failed to get AML alert details:", error);
    res.status(500).json({ error: "Failed to get AML alert details" });
  }
};

/**
 * Review an AML alert (update status)
 * PATCH /api/audit/aml/alerts/:alertId/review
 * Body: { status: "reviewed" | "dismissed", reviewNotes?: string }
 */
export const reviewAmlAlert = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { alertId } = req.params;
    const { status, reviewNotes } = req.body;

    if (!req.jwtUser?.userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const validStatuses = ["reviewed", "dismissed"];
    if (!status || !validStatuses.includes(status)) {
      res.status(400).json({
        error: "Invalid status",
        message: "Status must be one of: reviewed, dismissed",
      });
      return;
    }

    if (reviewNotes !== undefined && typeof reviewNotes !== "string") {
      res.status(400).json({
        error: "Invalid reviewNotes",
        message: "reviewNotes must be a string",
      });
      return;
    }

    const updated = await amlAlertModel.review(
      alertId,
      {
        status,
        reviewedBy: req.jwtUser.userId,
        reviewNotes,
      },
      req.jwtUser.userId,
    );

    if (!updated) {
      res.status(404).json({ error: "AML alert not found" });
      return;
    }

    res.json({
      message: "AML alert reviewed successfully",
      alert: updated,
    });
  } catch (error) {
    console.error("Failed to review AML alert:", error);
    res.status(500).json({ error: "Failed to review AML alert" });
  }
};

/**
 * Search AML alerts by user ID with intensity (severity) filter
 * GET /api/audit/aml/alerts/search
 * Query params: userId (required), intensity (optional: medium|high)
 */
export const searchAmlAlertsByUser = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { userId, intensity, limit, offset, before, after } = req.query;

    if (!userId || typeof userId !== "string") {
      res.status(400).json({
        error: "Missing userId",
        message: "userId query parameter is required",
      });
      return;
    }

    const filter: AMLAlertFilter = { userId };

    if (intensity && typeof intensity === "string") {
      const validIntensities = ["medium", "high"];
      if (!validIntensities.includes(intensity)) {
        res.status(400).json({
          error: "Invalid intensity",
          message: "Intensity must be one of: medium, high",
        });
        return;
      }
      filter.severity = intensity as "medium" | "high";
    }

    if (limit && typeof limit === "string") {
      const parsedLimit = parseInt(limit, 10);
      if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
        res.status(400).json({
          error: "Invalid limit",
          message: "Limit must be between 1 and 100",
        });
        return;
      }
      filter.limit = parsedLimit;
    }

    if (offset && typeof offset === "string") {
      const parsedOffset = parseInt(offset, 10);
      if (isNaN(parsedOffset) || parsedOffset < 0) {
        res.status(400).json({
          error: "Invalid offset",
          message: "Offset must be >= 0",
        });
        return;
      }
      filter.offset = parsedOffset;
    }

    if (before && typeof before === "string") {
      filter.before = before;
    }

    if (after && typeof after === "string") {
      filter.after = after;
    }

    const result = await amlAlertModel.list(filter);

    const limitVal = filter.limit ?? 50;
    const pagination: any = {
      total: result.total,
      limit: limitVal,
    };

    if (before || after || filter.before || filter.after) {
      pagination.before = result.alerts.length
        ? Buffer.from(`${result.alerts[0].createdAt}|${result.alerts[0].id}`).toString("base64")
        : null;
      pagination.after = result.alerts.length
        ? Buffer.from(`${result.alerts[result.alerts.length - 1].createdAt}|${result.alerts[result.alerts.length - 1].id}`).toString("base64")
        : null;
      pagination.hasMore = result.hasMore ?? false;
    } else {
      pagination.offset = filter.offset ?? 0;
      pagination.hasMore = result.hasMore ?? false;
    }

    res.json({
      data: result.alerts,
      pagination,
      pendingReview: result.pendingReview,
    });
  } catch (error) {
    console.error("Failed to search AML alerts by user:", error);
    res.status(500).json({ error: "Failed to search AML alerts" });
  }
};

/**
 * Get AML dashboard statistics
 * GET /api/audit/aml/stats
 */
export const getAmlDashboardStats = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { startDate, endDate } = req.query;

    const filter: AMLAlertFilter = {};

    if (startDate && typeof startDate === "string") {
      filter.startDate = new Date(startDate);
    }

    if (endDate && typeof endDate === "string") {
      filter.endDate = new Date(endDate);
    }

    // Get all alerts for the period
    const allAlerts = await amlAlertModel.list(filter);

    // Get breakdown by status
    const pendingResult = await amlAlertModel.list({
      ...filter,
      status: "pending_review",
    });
    const reviewedResult = await amlAlertModel.list({
      ...filter,
      status: "reviewed",
    });
    const dismissedResult = await amlAlertModel.list({
      ...filter,
      status: "dismissed",
    });

    // Get breakdown by severity
    const highSeverityResult = await amlAlertModel.list({
      ...filter,
      severity: "high",
    });
    const mediumSeverityResult = await amlAlertModel.list({
      ...filter,
      severity: "medium",
    });

    res.json({
      summary: {
        total: allAlerts.total,
        pendingReview: pendingResult.total,
        reviewed: reviewedResult.total,
        dismissed: dismissedResult.total,
        highSeverity: highSeverityResult.total,
        mediumSeverity: mediumSeverityResult.total,
      },
      period: {
        startDate: filter.startDate?.toISOString() || null,
        endDate: filter.endDate?.toISOString() || null,
      },
    });
  } catch (error) {
    console.error("Failed to get AML dashboard stats:", error);
    res.status(500).json({ error: "Failed to get AML dashboard stats" });
  }
};

/**
 * Manually trigger SAR generation for an alert
 * POST /api/audit/aml/alerts/:alertId/sar
 */
export const markAlertForSAR = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { alertId } = req.params;
    const { generateSAR } = await import("../compliance/sar.js");

    const alert = await amlAlertModel.findById(alertId);
    if (!alert) {
      res.status(404).json({ error: "AML alert not found" });
      return;
    }

    const { pdfUrl, xmlUrl } = await generateSAR(alert.userId, alertId);

    await amlAlertModel.review(
      alertId,
      {
        status: "reviewed",
        reviewedBy: req.jwtUser?.userId || "system",
        reviewNotes: `[SAR GENERATED] Manual SAR export triggered. PDF: ${pdfUrl}, XML: ${xmlUrl}`,
      },
      req.jwtUser?.userId || "system",
    );

    res.json({
      message: "SAR reports generated successfully",
      pdfUrl,
      xmlUrl,
    });
  } catch (error) {
    console.error("Failed to mark alert for SAR:", error);
    res.status(500).json({ error: "Failed to generate SAR reports" });
  }
};

/**
 * Hold a transaction for AML review
 * POST /api/audit/aml/transactions/:transactionId/hold
 */
export const holdTransaction = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { transactionId } = req.params;
    const { reason } = req.body;

    if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
      res.status(400).json({ error: "Reason is required" });
      return;
    }

    const transaction = await transactionModel.findById(transactionId);
    if (!transaction) {
      res.status(404).json({ error: "Transaction not found" });
      return;
    }

    await amlService.holdTransaction(transactionId, reason.trim(), req.jwtUser?.userId || "system");

    res.json({ message: "Transaction held for AML review", transactionId });
  } catch (error) {
    console.error("Failed to hold transaction:", error);
    res.status(500).json({ error: "Failed to hold transaction" });
  }
};

/**
 * Release a held transaction
 * POST /api/audit/aml/transactions/:transactionId/release
 */
export const releaseHeldTransaction = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { transactionId } = req.params;

    const transaction = await transactionModel.findById(transactionId);
    if (!transaction) {
      res.status(404).json({ error: "Transaction not found" });
      return;
    }

    await transactionModel.updateStatus(transactionId, "pending");
    await transactionModel.updateAdminNotes(
      transactionId,
      `[AML_RELEASE] Transaction released from hold by ${req.jwtUser?.userId || "system"}`,
    );

    res.json({ message: "Transaction released from AML hold", transactionId });
  } catch (error) {
    console.error("Failed to release held transaction:", error);
    res.status(500).json({ error: "Failed to release held transaction" });
  }
};

/**
 * List held transactions for AML review
 * GET /api/audit/aml/transactions/held
 */
export const listHeldTransactions = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  try {
    const held = amlService.getHeldTransactions(200);
    res.json({ data: held });
  } catch (error) {
    console.error("Failed to list held transactions:", error);
    res.status(500).json({ error: "Failed to list held transactions" });
  }
};
