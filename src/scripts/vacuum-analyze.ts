import { runDbVacuumAnalyzeJob } from "../jobs/dbVacuumAnalyzeJob";
import { pool } from "../config/database";

async function main() {
  console.log("=== Triggering Manual Off-Peak Vacuum and Analyze ===");
  try {
    const results = await runDbVacuumAnalyzeJob();
    console.log("Results summary:", results);
  } catch (error) {
    console.error("Execution failed:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
