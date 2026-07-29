import { softDeleteService } from "../services/softDeleteService";
import { env } from "../config/env";

export async function runPurgeSoftDeletedRecordsJob(): Promise<void> {
  console.info("[purge-soft-delete-job] Running nightly soft-deleted records purge job");
  try {
    const report = await softDeleteService.purgeSoftDeletedRecords(env.SOFT_DELETE_RETENTION_DAYS);
    console.info("[purge-soft-delete-job] Soft-delete purge job completed:", report);
  } catch (error: any) {
    console.error("[purge-soft-delete-job] Failed to execute soft delete purge job:", error?.message || error);
  }
}
