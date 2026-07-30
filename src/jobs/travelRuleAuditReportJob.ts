import {
  generateTravelRuleAuditReport,
  previousMonthRange,
} from "../reports/travelRuleAuditReport";

/**
 * Travel Rule Audit Report Job
 * Schedule: 1st of every month at midnight (0 0 1 * *)
 * Generates the previous month's Travel Rule coverage summary for
 * regulatory review. Full PDF/CSV exports are available on-demand via
 * GET /api/v1/compliance/travel-rule/audit-report.{csv,pdf}
 */
export async function runTravelRuleAuditReportJob(): Promise<void> {
  const { start, end } = previousMonthRange(new Date());
  const report = await generateTravelRuleAuditReport(start, end);

  console.log(
    `[travel-rule-audit] ${start.toISOString().slice(0, 7)}: ` +
      `${report.eligibleTransactionCount} eligible, ` +
      `${report.capturedRecordCount} captured, ` +
      `${report.coveragePercentage}% coverage, ` +
      `${report.missedTransactions.length} missed`,
  );

  if (report.missedTransactions.length > 0) {
    console.warn(
      `[travel-rule-audit] ${report.missedTransactions.length} transaction(s) missing Travel Rule data`,
    );
  }
}
