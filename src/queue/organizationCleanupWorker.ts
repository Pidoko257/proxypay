import { rabbitMQManager, QUEUES } from "./rabbitmq";
import { processOrganizationCleanup } from "./organizationCleanupQueue";
import logger from "../utils/logger";

const CONCURRENCY = Math.max(
  1,
  parseInt(process.env.ORGANIZATION_WORKER_CONCURRENCY || "1", 10),
);

async function startOrganizationCleanupWorker() {
  try {
    await rabbitMQManager.consume<{
      organizationId: string;
      performedBy: string;
      email: string;
      organizationName: string;
    }>(
      QUEUES.ORGANIZATION_CLEANUP,
      async (data) => {
        logger.info(
          { organizationId: data.organizationId },
          "Processing organization cleanup job",
        );
        await processOrganizationCleanup(data);
        logger.info(
          { organizationId: data.organizationId },
          "Organization cleanup job completed",
        );
      },
      CONCURRENCY,
    );

    logger.info("Organization cleanup worker started");
  } catch (error) {
    logger.error(
      { error },
      "Failed to start organization cleanup worker",
    );
    throw error;
  }
}

export { startOrganizationCleanupWorker };