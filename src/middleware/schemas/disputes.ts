/**
 * Disputes domain validation schemas.
 * Used with the validate() middleware factory.
 */
import { z } from "zod";

const DISPUTE_STATUSES = [
  "open",
  "investigating",
  "resolved",
  "rejected",
  "reversed",
  "upheld",
] as const;

const DISPUTE_PRIORITIES = ["low", "medium", "high", "critical"] as const;

export const OpenDisputeBodySchema = z.object({
  reason: z.string().min(1, "reason is required"),
  reportedBy: z.string().optional(),
  priority: z.enum(DISPUTE_PRIORITIES).optional(),
  category: z.string().optional(),
  requesterEmail: z.string().email("requesterEmail must be a valid email").optional(),
});

export const UpdateDisputeStatusBodySchema = z.object({
  status: z.enum(DISPUTE_STATUSES, {
    errorMap: () => ({
      message: `status must be one of: ${DISPUTE_STATUSES.join(", ")}`,
    }),
  }),
  resolution: z.string().optional(),
  assignedTo: z.string().optional(),
});

export const ResolveDisputeBodySchema = z.object({
  action: z.enum(["reverse", "uphold"], {
    errorMap: () => ({ message: "action must be 'reverse' or 'uphold'" }),
  }),
  resolution: z.string().min(1, "resolution is required"),
  adminId: z.string().optional(),
});

export const PatchDisputeBodySchema = z.object({
  priority: z.enum(DISPUTE_PRIORITIES).optional(),
  category: z.string().optional(),
  internalNotes: z.string().optional(),
});

export const AssignDisputeBodySchema = z.object({
  agentName: z.string().min(1, "agentName is required"),
});

export const AddDisputeNoteBodySchema = z.object({
  author: z.string().min(1, "author is required"),
  note: z.string().min(1, "note is required"),
});

export const DisputeIdParamsSchema = z.object({
  disputeId: z.string().min(1, "disputeId is required"),
});

export const TransactionIdParamsSchema = z.object({
  id: z.string().min(1, "Transaction id is required"),
});

export const DisputeReportQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  assignedTo: z.string().optional(),
});

export const SlaReportQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional(),
});

export type OpenDisputeBody = z.infer<typeof OpenDisputeBodySchema>;
export type UpdateDisputeStatusBody = z.infer<typeof UpdateDisputeStatusBodySchema>;
export type ResolveDisputeBody = z.infer<typeof ResolveDisputeBodySchema>;
export type PatchDisputeBody = z.infer<typeof PatchDisputeBodySchema>;
export type AssignDisputeBody = z.infer<typeof AssignDisputeBodySchema>;
export type AddDisputeNoteBody = z.infer<typeof AddDisputeNoteBodySchema>;
