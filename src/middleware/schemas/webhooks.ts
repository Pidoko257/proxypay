/**
 * Webhooks domain validation schemas.
 * Used with the validate() middleware factory.
 */
import { z } from "zod";

export const RegisterWebhookBodySchema = z.object({
  url: z.string().url("url must be a valid URL"),
  events: z
    .array(z.string().min(1))
    .min(1, "at least one event must be specified"),
  secret: z.string().min(16, "secret must be at least 16 characters").optional(),
  active: z.boolean().optional().default(true),
  description: z.string().max(500).optional(),
});

export const UpdateWebhookBodySchema = z.object({
  url: z.string().url("url must be a valid URL").optional(),
  events: z.array(z.string().min(1)).min(1).optional(),
  secret: z.string().min(16).optional(),
  active: z.boolean().optional(),
  description: z.string().max(500).optional(),
});

export const WebhookIdParamsSchema = z.object({
  id: z.string().min(1, "id is required"),
});

export type RegisterWebhookBody = z.infer<typeof RegisterWebhookBodySchema>;
export type UpdateWebhookBody = z.infer<typeof UpdateWebhookBodySchema>;
