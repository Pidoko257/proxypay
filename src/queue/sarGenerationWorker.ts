import { Job, Worker } from "bullmq";
import { queueOptions } from "./config";
import {
  SAR_GENERATION_JOB_NAME,
  SAR_GENERATION_QUEUE_NAME,
  SarGenerationJobData,
} from "./sarGenerationQueue";
import { instrumentWorker } from "./queueMetricsService";
import logger from "../utils/logger";
import { sarGenerationFailuresTotal } from "../utils/metrics";

let sarGenerationWorker: Worker<SarGenerationJobData> | null = null;

export function startSarGenerationWorker(): void {
  if (sarGenerationWorker) {
    return;
  }

  sarGenerationWorker = new Worker<SarGenerationJobData>(
    SAR_GENERATION_QUEUE_NAME,
    async (job: Job<SarGenerationJobData>) => {
      const { userId, alertId } = job.data;
      logger.info(
        { jobId: job.id, alertId, attempt: job.attemptsMade + 1 },
        "[SAR] Generating SAR for high-severity AML alert",
      );
      const { generateSAR } = await import("../compliance/sar.js");
      await generateSAR(userId, alertId);
    },
    {
      ...queueOptions,
      concurrency: Number.parseInt(process.env.SAR_GENERATION_CONCURRENCY || "2", 10),
    },
  );

  instrumentWorker(SAR_GENERATION_QUEUE_NAME, sarGenerationWorker);

  sarGenerationWorker.on("completed", (job) => {
    logger.info(
      { jobId: job.id, alertId: job.data.alertId },
      `[${SAR_GENERATION_JOB_NAME}] SAR generated`,
    );
  });

  sarGenerationWorker.on("failed", (job, error) => {
    const exhausted =
      !!job && job.attemptsMade >= (job.opts.attempts ?? 1);
    sarGenerationFailuresTotal.inc({
      stage: exhausted ? "generation_exhausted" : "generation_attempt",
    });
    logger.error(
      {
        jobId: job?.id,
        alertId: job?.data.alertId,
        attemptsMade: job?.attemptsMade,
        exhausted,
        err: error,
      },
      `[${SAR_GENERATION_JOB_NAME}] SAR generation failed`,
    );
  });
}

export async function closeSarGenerationWorker(): Promise<void> {
  if (!sarGenerationWorker) {
    return;
  }

  await sarGenerationWorker.close();
  sarGenerationWorker = null;
}
