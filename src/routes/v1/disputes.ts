import { Router, Request, Response } from "express";
import { setApiVersion } from "../../middleware/apiVersion";
import { TimeoutPresets, haltOnTimedout } from "../../middleware/timeout";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { DisputeService } from "../../services/dispute";
import { DisputeModel } from "../../models/dispute";
import { DisputeStatus } from "../../models/dispute";
import { uploadSingle } from "../../middleware/disputeUpload";
import { uploadDisputeEvidenceToS3, validateDisputeEvidenceFile } from "../../services/disputeS3Upload";
import { createError } from "../../middleware/errorHandler";
import { ERROR_CODES } from "../../constants/errorCodes";

const disputeService = new DisputeService();
const disputeModel = new DisputeModel();

export const transactionDisputeRoutesV1 = Router();
export const disputeRoutesV1 = Router();

// ─── Transaction-scoped ───────────────────────────────────────────────────────

/**
 * POST /api/v1/transactions/:transactionId/dispute
 * Open a dispute against a transaction.
 */
transactionDisputeRoutesV1.post(
  "/:transactionId/dispute",
  TimeoutPresets.long,
  haltOnTimedout,
  setApiVersion("v1"),
  requireAuth,
  requirePermission("dispute:create"),
  async (req: Request, res: Response) => {
    const { reason, reportedBy, priority, category } = req.body;
    if (!reason?.trim()) {
      throw createError(ERROR_CODES.MISSING_FIELD, '"reason" is required', { error: '"reason" is required' });
    }
    try {
      const dispute = await disputeService.openDispute(
        req.params.transactionId,
        reason.trim(),
        reportedBy,
        priority,
        category,
      );
      return res.status(201).json(dispute);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to open dispute";
      const code = msg.includes("not found") ? ERROR_CODES.NOT_FOUND
        : msg.includes("already exists") || msg.includes("only allowed") ? ERROR_CODES.CONFLICT
        : ERROR_CODES.INTERNAL_ERROR;
      throw createError(code, msg, { error: msg });
    }
  },
);

/**
 * GET /api/v1/transactions/:transactionId/disputes
 * List all disputes for a transaction.
 */
transactionDisputeRoutesV1.get(
  "/:transactionId/disputes",
  TimeoutPresets.quick,
  haltOnTimedout,
  setApiVersion("v1"),
  requireAuth,
  requirePermission("dispute:read"),
  async (req: Request, res: Response) => {
    try {
      const disputes = await disputeModel.findByTransactionId(req.params.transactionId);
      return res.json(disputes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to list disputes";
      throw createError(ERROR_CODES.INTERNAL_ERROR, msg, { error: msg });
    }
  },
);

// ─── Dispute management ───────────────────────────────────────────────────────

/**
 * GET /api/v1/disputes
 * List disputes (paginated).
 */
disputeRoutesV1.get(
  "/",
  TimeoutPresets.quick,
  haltOnTimedout,
  setApiVersion("v1"),
  requireAuth,
  requirePermission("dispute:read"),
  async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const status = req.query.status as DisputeStatus | undefined;
    try {
      const disputes = await disputeModel.findAll({ status, limit, offset });
      return res.json(disputes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to list disputes";
      throw createError(ERROR_CODES.INTERNAL_ERROR, msg, { error: msg });
    }
  },
);

/**
 * GET /api/v1/disputes/:disputeId
 * Get dispute details with notes.
 */
disputeRoutesV1.get(
  "/:disputeId",
  TimeoutPresets.quick,
  haltOnTimedout,
  setApiVersion("v1"),
  requireAuth,
  requirePermission("dispute:read"),
  async (req: Request, res: Response) => {
    try {
      const dispute = await disputeService.getDisputeWithDetails(req.params.disputeId);
      return res.json(dispute);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to get dispute";
      throw createError(
        msg.includes("not found") ? ERROR_CODES.NOT_FOUND : ERROR_CODES.INTERNAL_ERROR,
        msg, { error: msg },
      );
    }
  },
);

/**
 * PUT /api/v1/disputes/:disputeId/evidence
 * Attach evidence to a dispute.
 */
disputeRoutesV1.put(
  "/:disputeId/evidence",
  TimeoutPresets.long,
  haltOnTimedout,
  setApiVersion("v1"),
  requireAuth,
  requirePermission("dispute:update"),
  uploadSingle.single("file"),
  async (req: Request, res: Response) => {
    const { disputeId } = req.params;
    const file = req.file;
    if (!file) throw createError(ERROR_CODES.INVALID_INPUT, "No file uploaded", { error: "No file uploaded" });

    const validation = validateDisputeEvidenceFile(file);
    if (!validation.valid) throw createError(ERROR_CODES.INVALID_INPUT, validation.error, { error: validation.error });

    try {
      const upload = await uploadDisputeEvidenceToS3({ disputeId, file, uploadedBy: req.user?.id || "unknown" });
      if (!upload.success) throw createError(ERROR_CODES.INTERNAL_ERROR, upload.error, { error: upload.error });

      const evidence = await disputeService.addEvidence(
        disputeId,
        file.originalname,
        file.mimetype,
        file.size,
        upload.key!,
        upload.fileUrl!,
        req.user?.id || "unknown",
        req.body.description,
      );
      return res.status(201).json(evidence);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to attach evidence";
      throw createError(
        msg.includes("not found") ? ERROR_CODES.NOT_FOUND : ERROR_CODES.INTERNAL_ERROR,
        msg, { error: msg },
      );
    }
  },
);

/**
 * PATCH /api/v1/disputes/:disputeId
 * Update dispute status (admin) or metadata fields.
 * Body: { status?, resolution?, assignedTo?, priority?, category?, internalNotes? }
 */
disputeRoutesV1.patch(
  "/:disputeId",
  TimeoutPresets.long,
  haltOnTimedout,
  setApiVersion("v1"),
  requireAuth,
  requirePermission("dispute:update"),
  async (req: Request, res: Response) => {
    const { status, resolution, assignedTo, priority, category, internalNotes } = req.body;

    try {
      // Status transition takes precedence when status is provided.
      if (status) {
        const VALID_STATUSES: DisputeStatus[] = ["open", "investigating", "resolved", "rejected", "reversed", "upheld"];
        if (!VALID_STATUSES.includes(status)) {
          throw createError(ERROR_CODES.INVALID_INPUT, `"status" must be one of: ${VALID_STATUSES.join(", ")}`, { error: `Invalid status: ${status}` });
        }
        // Status transitions that move to terminal states are admin-only.
        const TERMINAL: DisputeStatus[] = ["resolved", "rejected", "reversed", "upheld"];
        if (TERMINAL.includes(status)) {
          await requirePermission("dispute:manage")(req, res, () => {});
        }
        const updated = await disputeService.updateStatus(req.params.disputeId, status, resolution, assignedTo);
        return res.json(updated);
      }

      // Otherwise update metadata fields.
      const updated = await disputeService.updateDispute(req.params.disputeId, { priority, category, internalNotes });
      return res.json(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update dispute";
      const code = msg.includes("not found") ? ERROR_CODES.NOT_FOUND
        : msg.includes("Cannot transition") || msg.includes("resolution text") ? ERROR_CODES.UNPROCESSABLE_CONTENT
        : ERROR_CODES.INTERNAL_ERROR;
      throw createError(code, msg, { error: msg });
    }
  },
);

/**
 * POST /api/v1/disputes/:disputeId/close
 * Close a dispute with a resolution (admin only).
 * Body: { action: 'reverse'|'uphold', resolution: string }
 */
disputeRoutesV1.post(
  "/:disputeId/close",
  TimeoutPresets.long,
  haltOnTimedout,
  setApiVersion("v1"),
  requireAuth,
  requirePermission("dispute:manage"),
  async (req: Request, res: Response) => {
    const { action, resolution } = req.body;
    if (action !== "reverse" && action !== "uphold") {
      throw createError(ERROR_CODES.INVALID_INPUT, '"action" must be "reverse" or "uphold"', { error: 'Invalid action' });
    }
    if (!resolution?.trim()) {
      throw createError(ERROR_CODES.MISSING_FIELD, '"resolution" is required', { error: '"resolution" is required' });
    }
    try {
      const updated = await disputeService.resolvePayment(
        req.params.disputeId,
        action,
        resolution.trim(),
        req.user?.id,
      );
      return res.json(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to close dispute";
      const code = msg.includes("not found") ? ERROR_CODES.NOT_FOUND
        : msg.includes("Cannot resolve") ? ERROR_CODES.UNPROCESSABLE_CONTENT
        : ERROR_CODES.INTERNAL_ERROR;
      throw createError(code, msg, { error: msg });
    }
  },
);
