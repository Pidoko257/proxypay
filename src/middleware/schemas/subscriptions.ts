/**
 * Subscriptions domain validation schemas.
 * Used with the validate() middleware factory.
 */
import { z } from "zod";

export const CreateSubscriptionBodySchema = z.object({
  user_id: z.string().optional().nullable(),
  phone_number: z.string().optional().nullable(),
  amount: z.union([z.string(), z.number()]),
  currency: z.string().optional().default("USD"),
  interval: z.enum(["daily", "weekly", "monthly"], {
    errorMap: () => ({ message: "interval must be 'daily', 'weekly', or 'monthly'" }),
  }),
  next_run_at: z.string().optional(),
  metadata: z.any().optional(),
  max_retries: z.number().int().min(0).optional(),
  retry_backoff_seconds: z.number().int().min(0).optional(),
});

export const SubscriptionIdParamsSchema = z.object({
  id: z.string().min(1, "id is required"),
});

export type CreateSubscriptionBody = z.infer<typeof CreateSubscriptionBodySchema>;
