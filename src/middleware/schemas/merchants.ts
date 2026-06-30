/**
 * Merchants domain validation schemas.
 * Used with the validate() middleware factory.
 */
import { z } from "zod";

export const CreateMerchantBodySchema = z.object({
  name: z.string().trim().min(1, "name is required").max(255),
  email: z.string().email("email must be a valid email address"),
  phone_number: z
    .string()
    .regex(/^\+?\d{7,15}$/, "phone_number must be a valid phone number (7-15 digits)"),
  business_name: z.string().max(255).optional(),
  business_type: z.string().max(100).optional(),
  tax_id: z.string().max(50).optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/, "country must be a valid ISO 3166-1 alpha-2 code (e.g., US, CM)")
    .optional(),
});

export const UpdateMerchantBodySchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  email: z.string().email().optional(),
  phone_number: z
    .string()
    .regex(/^\+?\d{7,15}$/)
    .optional(),
  business_name: z.string().max(255).optional(),
  business_type: z.string().max(100).optional(),
  tax_id: z.string().max(50).optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
});

export const MerchantIdParamsSchema = z.object({
  merchantId: z.string().min(1, "merchantId is required"),
});

export const MerchantIdFromIdParamsSchema = z.object({
  id: z.string().min(1, "id is required"),
});

export type CreateMerchantBody = z.infer<typeof CreateMerchantBodySchema>;
export type UpdateMerchantBody = z.infer<typeof UpdateMerchantBodySchema>;
