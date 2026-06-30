/**
 * Transaction domain validation schemas.
 * Used with the validate() middleware factory.
 */
import { z } from "zod";

export const TransactionBodySchema = z.object({
  amount: z.number().positive("Amount must be a positive number"),
  phoneNumber: z
    .string()
    .regex(/^\+?\d{10,15}$/, "Invalid phone number format"),
  provider: z.enum(["MTN", "AIRTEL", "ORANGE"], {
    errorMap: () => ({ message: "Provider must be one of: MTN, AIRTEL, ORANGE" }),
  }),
  stellarAddress: z.string().min(1, "stellarAddress is required"),
  userId: z.string().min(1, "userId is required"),
  notes: z.string().max(256).optional(),
});

export const UpdateNotesBodySchema = z.object({
  notes: z.string().max(256, "notes must be 256 characters or fewer"),
});

export const MetadataBodySchema = z.object({
  metadata: z.record(z.string(), z.unknown()),
});

export const DeleteMetadataKeysBodySchema = z.object({
  keys: z.array(z.string()).min(1, "At least one key is required"),
});

export const TransactionIdParamsSchema = z.object({
  id: z.string().min(1, "Transaction id is required"),
});

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  status: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  provider: z.string().optional(),
});

export const SearchMetadataBodySchema = z.object({
  key: z.string().min(1, "key is required"),
  value: z.unknown(),
});

export type TransactionBody = z.infer<typeof TransactionBodySchema>;
export type UpdateNotesBody = z.infer<typeof UpdateNotesBodySchema>;
export type MetadataBody = z.infer<typeof MetadataBodySchema>;
export type DeleteMetadataKeysBody = z.infer<typeof DeleteMetadataKeysBodySchema>;
export type TransactionIdParams = z.infer<typeof TransactionIdParamsSchema>;
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;
