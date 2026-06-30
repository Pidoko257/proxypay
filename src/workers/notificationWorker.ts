import IORedis from "ioredis";
import { SubscriptionChannels } from "../graphql/subscriptions";
import { notificationRouter } from "../services/notificationRouter";
import { TransactionModel } from "../models/transaction";
import { sharedIORedisSubscriber } from "../config/redis";

/**
 * Notification worker — subscribes to transaction update channels in Redis
 * and routes user-facing notifications (email/sms/push/etc.) via
 * `NotificationRouter`. This replaces DB polling for notification triggers.
 */
export async function startNotificationWorker(): Promise<void> {
  if (!process.env.REDIS_URL) {
    console.warn(
      "NotificationWorker: REDIS_URL not set — running without Redis subscription",
    );
    return;
  }

  try {
    await sharedIORedisSubscriber.connect();
  } catch (err) {
    console.warn("NotificationWorker: Redis connection failed", err);
    return;
  }

  // Subscribe to broadcast updates and per-transaction channels (pattern)
  await sharedIORedisSubscriber.subscribe(SubscriptionChannels.TRANSACTION_UPDATED);
  await sharedIORedisSubscriber.psubscribe("TRANSACTION_UPDATED:*");

  sharedIORedisSubscriber.on("message", async (_channel: string, rawMessage: string) => {
    try {
      const payload = JSON.parse(rawMessage) as {
        id?: string;
        status?: string;
        [key: string]: any;
      };

      const txId = payload.id;
      const status = payload.status;
      if (!txId || !status) return;

      const txModel = new TransactionModel();
      const tx = await txModel.findById(txId);
      if (!tx) return;

      if (status === "completed") {
        await notificationRouter.routeTransactionNotification(tx, "completed");
      } else if (status === "failed") {
        await notificationRouter.routeTransactionNotification(tx, "failed", payload.error);
      }
    } catch (err) {
      console.error("NotificationWorker: failed to handle message:", err);
    }
  });

  // pmessage handles pattern subscriptions (TRANSACTION_UPDATED:<id>)
  sharedIORedisSubscriber.on(
    "pmessage",
    async (_pattern: string, _channel: string, rawMessage: string) => {
      try {
        const payload = JSON.parse(rawMessage) as {
          id?: string;
          status?: string;
          [key: string]: any;
        };

        const txId = payload.id;
        const status = payload.status;
        if (!txId || !status) return;

        const txModel = new TransactionModel();
        const tx = await txModel.findById(txId);
        if (!tx) return;

        if (status === "completed") {
          await notificationRouter.routeTransactionNotification(tx, "completed");
        } else if (status === "failed") {
          await notificationRouter.routeTransactionNotification(tx, "failed", payload.error);
        }
      } catch (err) {
        console.error("NotificationWorker: failed to handle pmessage:", err);
      }
    },
  );

  console.log("NotificationWorker: subscribed to transaction update channels");
}

export async function stopNotificationWorker(): Promise<void> {
  try {
    await sharedIORedisSubscriber.unsubscribe(SubscriptionChannels.TRANSACTION_UPDATED);
    await sharedIORedisSubscriber.punsubscribe("TRANSACTION_UPDATED:*");
    console.log("NotificationWorker: stopped");
  } catch (err) {
    console.warn("NotificationWorker: stop error:", err);
  }
}
