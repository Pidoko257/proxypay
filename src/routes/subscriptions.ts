import { Router, Request, Response } from "express";
import { z } from "zod";
import { authenticateToken } from "../middleware/auth";
import { validate } from "../middleware/validation";
import {
  CreateSubscriptionBodySchema,
  SubscriptionIdParamsSchema,
} from "../middleware/schemas/subscriptions";
import subscriptionModel from "../models/subscription";
import { encrypt } from "../utils/encryption";
import { notificationRouter } from "../services/notificationRouter";

export const subscriptionsRoutes = Router();

/** Inline schema for update — only defined here since it's a partial and domain-specific */
const UpdateSubscriptionBodySchema = z
  .object({
    phone_number: z.string().optional().nullable(),
    amount: z.union([z.string(), z.number()]).optional(),
    currency: z.string().optional(),
    interval: z.enum(["daily", "weekly", "monthly"]).optional(),
    next_run_at: z.string().optional().nullable(),
    metadata: z.any().optional(),
    max_retries: z.number().int().min(0).optional(),
    retry_backoff_seconds: z.number().int().min(0).optional(),
    status: z.string().optional(),
  })
  .partial();

// Create subscription
subscriptionsRoutes.post(
  "/",
  authenticateToken,
  validate({ body: CreateSubscriptionBodySchema }),
  async (req: Request, res: Response) => {
    try {
      const user = req.jwtUser as any;
      if (!user || !user.userId) return res.status(401).json({ error: "Unauthorized" });

      const encPhone = req.body.phone_number
        ? encrypt(req.body.phone_number)
        : null;

      const created = await subscriptionModel.create({
        merchant_id: user.userId,
        user_id: req.body.user_id ?? null,
        phone_number: encPhone,
        amount: req.body.amount,
        currency: req.body.currency,
        interval: req.body.interval,
        next_run_at: req.body.next_run_at ?? null,
        metadata: req.body.metadata ?? {},
        max_retries: req.body.max_retries ?? 3,
        retry_backoff_seconds: req.body.retry_backoff_seconds ?? 600,
      });

      await notificationRouter.routeSystemNotification(
        "low",
        "subscription",
        "Subscription Created",
        `Subscription ${created.id} created`,
        { subscriptionId: created.id },
      );

      res.status(201).json({ subscription: created });
    } catch (err) {
      console.error("Failed to create subscription", err);
      res.status(500).json({ error: "Failed to create subscription" });
    }
  },
);

// List merchant subscriptions
subscriptionsRoutes.get("/", authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = req.jwtUser as any;
    if (!user || !user.userId) return res.status(401).json({ error: "Unauthorized" });
    const rows = await subscriptionModel.listByMerchant(user.userId);
    res.json({ subscriptions: rows });
  } catch (err) {
    console.error("Failed to list subscriptions", err);
    res.status(500).json({ error: "Failed to list subscriptions" });
  }
});

// Get subscription
subscriptionsRoutes.get(
  "/:id",
  authenticateToken,
  validate({ params: SubscriptionIdParamsSchema }),
  async (req: Request, res: Response) => {
    try {
      const user = req.jwtUser as any;
      if (!user || !user.userId) return res.status(401).json({ error: "Unauthorized" });
      const sub = await subscriptionModel.getById(req.params.id);
      if (!sub) return res.status(404).json({ error: "Subscription not found" });
      if (sub.merchant_id !== user.userId) return res.status(403).json({ error: "Forbidden" });
      res.json({ subscription: sub });
    } catch (err) {
      console.error("Failed to get subscription", err);
      res.status(500).json({ error: "Failed to get subscription" });
    }
  },
);

// Update subscription (pause/resume/cancel or fields)
subscriptionsRoutes.patch(
  "/:id",
  authenticateToken,
  validate({ body: UpdateSubscriptionBodySchema, params: SubscriptionIdParamsSchema }),
  async (req: Request, res: Response) => {
    try {
      const user = req.jwtUser as any;
      if (!user || !user.userId) return res.status(401).json({ error: "Unauthorized" });
      const sub = await subscriptionModel.getById(req.params.id);
      if (!sub) return res.status(404).json({ error: "Subscription not found" });
      if (sub.merchant_id !== user.userId) return res.status(403).json({ error: "Forbidden" });

      const updateData = { ...req.body };
      if (updateData.phone_number) {
        updateData.phone_number = encrypt(updateData.phone_number);
      }
      const updated = await subscriptionModel.update(req.params.id, updateData as any);
      res.json({ subscription: updated });
    } catch (err) {
      console.error("Failed to update subscription", err);
      res.status(500).json({ error: "Failed to update subscription" });
    }
  },
);

// Delete (cancel) subscription
subscriptionsRoutes.delete(
  "/:id",
  authenticateToken,
  validate({ params: SubscriptionIdParamsSchema }),
  async (req: Request, res: Response) => {
    try {
      const user = req.jwtUser as any;
      if (!user || !user.userId) return res.status(401).json({ error: "Unauthorized" });
      const sub = await subscriptionModel.getById(req.params.id);
      if (!sub) return res.status(404).json({ error: "Subscription not found" });
      if (sub.merchant_id !== user.userId) return res.status(403).json({ error: "Forbidden" });
      await subscriptionModel.delete(req.params.id);
      res.status(204).end();
    } catch (err) {
      console.error("Failed to delete subscription", err);
      res.status(500).json({ error: "Failed to delete subscription" });
    }
  },
);

// Pause subscription
subscriptionsRoutes.post(
  "/:id/pause",
  authenticateToken,
  validate({ params: SubscriptionIdParamsSchema }),
  async (req: Request, res: Response) => {
    try {
      const user = req.jwtUser as any;
      if (!user || !user.userId) return res.status(401).json({ error: "Unauthorized" });
      const sub = await subscriptionModel.getById(req.params.id);
      if (!sub) return res.status(404).json({ error: "Subscription not found" });
      if (sub.merchant_id !== user.userId) return res.status(403).json({ error: "Forbidden" });
      await subscriptionModel.pause(req.params.id);
      await notificationRouter.routeSystemNotification(
        "medium",
        "subscription",
        "Subscription Paused",
        `Subscription ${req.params.id} was paused by merchant`,
        { subscriptionId: req.params.id },
      );
      res.status(200).json({ paused: true });
    } catch (err) {
      console.error("Failed to pause subscription", err);
      res.status(500).json({ error: "Failed to pause subscription" });
    }
  },
);

// Resume subscription
subscriptionsRoutes.post(
  "/:id/resume",
  authenticateToken,
  validate({ params: SubscriptionIdParamsSchema }),
  async (req: Request, res: Response) => {
    try {
      const user = req.jwtUser as any;
      if (!user || !user.userId) return res.status(401).json({ error: "Unauthorized" });
      const sub = await subscriptionModel.getById(req.params.id);
      if (!sub) return res.status(404).json({ error: "Subscription not found" });
      if (sub.merchant_id !== user.userId) return res.status(403).json({ error: "Forbidden" });
      await subscriptionModel.resume(req.params.id);
      await notificationRouter.routeSystemNotification(
        "low",
        "subscription",
        "Subscription Resumed",
        `Subscription ${req.params.id} was resumed by merchant`,
        { subscriptionId: req.params.id },
      );
      const refreshed = await subscriptionModel.getById(req.params.id);
      res.json({ subscription: refreshed });
    } catch (err) {
      console.error("Failed to resume subscription", err);
      res.status(500).json({ error: "Failed to resume subscription" });
    }
  },
);

export default subscriptionsRoutes;
