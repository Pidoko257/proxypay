/**
 * Users domain validation schemas.
 * Used with the validate() middleware factory.
 */
import { z } from "zod";

export const UpdateDisplayNameBodySchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, "displayName is required")
    .max(120, "displayName must be 120 characters or fewer"),
});

export type UpdateDisplayNameBody = z.infer<typeof UpdateDisplayNameBodySchema>;
