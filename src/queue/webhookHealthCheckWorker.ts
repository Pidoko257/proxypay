import { Job, Worker } from "bullmq";
import { runWebhookHealthCheckJob } from "../jobs/webhookHealthCheckJob";
import { queueOptions } from "./config";
import {
  WEBHOOK_HEALTH_CHECK_JOB_NAME,
  WEBHOOK_HEALTH_CHECK_QUEUE_NAME,
  WebhookHealthCheckJobData,
} from "./webhookHealthCheckQueue";

let webhookHealthCheckWorker: Worker<WebhookHealthCheckJobData> | null = null;

export function startWebhookHealthCheckWorker(): void {
  if (webhookHealthCheckWorker) {
    return; // already running
  }

  webhookHealthCheckWorker = new Worker<WebhookHealthCheckJobData>(
    WEBHOOK_HEALTH_CHECK_QUEUE_NAME,
    async (job: Job<WebhookHealthCheckJobData>) => {
      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "info",
          service: WEBHOOK_HEALTH_CHECK_JOB_NAME,
          message: `Running job ${job.id}`,
          triggeredBy: job.data.triggeredBy,
        }),
      );
      await runWebhookHealthCheckJob();
    },
    {
      ...queueOptions,
      // Only one instance of this job should run at a time
      concurrency: 1,
    },
  );

  webhookHealthCheckWorker.on("completed", (job) => {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "info",
        service: WEBHOOK_HEALTH_CHECK_JOB_NAME,
        message: `Completed job ${job.id}`,
      }),
    );
  });

  webhookHealthCheckWorker.on("failed", (job, error) => {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        service: WEBHOOK_HEALTH_CHECK_JOB_NAME,
        message: `Failed job ${job?.id}: ${error.message}`,
      }),
    );
  });
}

export async function closeWebhookHealthCheckWorker(): Promise<void> {
  if (!webhookHealthCheckWorker) {
    return;
  }
  await webhookHealthCheckWorker.close();
  webhookHealthCheckWorker = null;
}
