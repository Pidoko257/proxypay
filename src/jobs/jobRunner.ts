import type { PagerDutyService } from "../services/pagerDutyService";
import logger from "../utils/logger";
import { jobFailuresTotal } from "../utils/metrics";

export interface JobConfig {
  name: string;
  schedule: string;
  handler: () => Promise<void>;
  /** Page on-call via PagerDuty when this job fails. */
  critical?: boolean;
}

let failureAlerting: PagerDutyService | null = null;

/** Register the PagerDuty service used to page on critical job failures. */
export function setJobFailureAlerting(service: PagerDutyService | null): void {
  failureAlerting = service;
}

/**
 * Run a scheduled job. Failures are never re-thrown (so one broken job can't
 * take down the scheduler) but are made visible: a job_failures_total metric
 * is incremented, the error is logged via the structured logger, and
 * critical jobs page on-call through PagerDuty.
 */
export async function runJob(
  job: JobConfig,
  alerting: PagerDutyService | null = failureAlerting,
): Promise<void> {
  console.log(`[${job.name}] Starting job`);
  try {
    await job.handler();
    console.log(`[${job.name}] Completed`);
  } catch (err) {
    jobFailuresTotal.inc({ job_name: job.name });
    logger.error(
      { err, job_name: job.name, critical: !!job.critical },
      `[${job.name}] Scheduled job failed`,
    );

    if (job.critical && alerting) {
      await alerting
        .triggerAlert({
          summary: `[CRITICAL] Scheduled job "${job.name}" failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          dedupKey: `job-failure-${job.name}`,
          source: "proxypay-scheduler",
          details: { job_name: job.name, schedule: job.schedule },
        })
        .catch((alertErr) =>
          logger.error(
            { err: alertErr, job_name: job.name },
            "Failed to send PagerDuty alert for job failure",
          ),
        );
    }
  }
}
