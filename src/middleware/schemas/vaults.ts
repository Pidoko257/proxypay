/**
 * Vaults domain validation schemas.
 * Used with the validate() middleware factory.
 */
import { z } from "zod";

export const CreateVaultBodySchema = z.object({
  name: z.string().trim().min(1, "name is required").max(255),
  currency: z.string().min(1, "currency is required").max(10),
  description: z.string().max(500).optional(),
});

export const UpdateVaultBodySchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  currency: z.string().min(1).max(10).optional(),
  description: z.string().max(500).optional(),
});

export const TransferFundsBodySchema = z.object({
  amount: z.number().positive("amount must be a positive number"),
  direction: z.enum(["deposit", "withdraw"], {
    errorMap: () => ({ message: "direction must be 'deposit' or 'withdraw'" }),
  }),
  reference: z.string().optional(),
  notes: z.string().max(256).optional(),
});

export const VaultIdParamsSchema = z.object({
  vaultId: z.string().min(1, "vaultId is required"),
});

export type CreateVaultBody = z.infer<typeof CreateVaultBodySchema>;
export type UpdateVaultBody = z.infer<typeof UpdateVaultBodySchema>;
export type TransferFundsBody = z.infer<typeof TransferFundsBodySchema>;
export type VaultIdParams = z.infer<typeof VaultIdParamsSchema>;
