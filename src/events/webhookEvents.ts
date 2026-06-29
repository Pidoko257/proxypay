import { EventEmitter } from "events";

export interface WebhookDeliveryFailedEvent {
  webhookId: string;
  eventType: string;
  jobId?: string;
  attemptsMade: number;
  errorMessage: string;
}

export const WEBHOOK_DELIVERY_FAILED_EVENT = "webhook.delivery_failed";

export const webhookEvents = new EventEmitter();
