/**
 * Travel Rule Compliance Audit Report — FATF Recommendation 16
 *
 * Compares transactions eligible for Travel Rule data collection
 * (deposits >= TRAVEL_RULE_THRESHOLD_USD) against captured
 * `travel_rule_records` for a given period, to surface coverage gaps
 * for regulatory review.
 */

import PDFDocument from "pdfkit";
import { pool } from "../config/database";
import { TRAVEL_RULE_THRESHOLD_USD } from "../compliance/travelRule";

export interface TravelRuleAuditReport {
  periodStart: string;
  periodEnd: string;
  eligibleTransactionCount: number;
  capturedRecordCount: number;
  coveragePercentage: number;
  missedTransactions: Array<{
    transactionId: string;
    amount: number;
    createdAt: string;
  }>;
  // No automated remediation-tracking exists yet — compliance officers
  // populate this manually after following up on `missedTransactions`.
  correctiveActionsTaken: string[];
  generatedAt: string;
}

/** Generates a Travel Rule coverage report for [periodStart, periodEnd). */
export async function generateTravelRuleAuditReport(
  periodStart: Date,
  periodEnd: Date,
): Promise<TravelRuleAuditReport> {
  const result = await pool.query<{
    id: string;
    amount: string;
    created_at: Date;
    captured: boolean;
  }>(
    `SELECT t.id, t.amount, t.created_at, (r.id IS NOT NULL) AS captured
     FROM transactions t
     LEFT JOIN travel_rule_records r ON r.transaction_id = t.id
     WHERE t.type = 'deposit'
       AND t.status = 'completed'
       AND t.amount >= $1
       AND t.created_at >= $2
       AND t.created_at < $3
     ORDER BY t.created_at ASC`,
    [TRAVEL_RULE_THRESHOLD_USD, periodStart, periodEnd],
  );

  const eligible = result.rows;
  const missed = eligible.filter((row) => !row.captured);
  const capturedCount = eligible.length - missed.length;
  const coveragePercentage =
    eligible.length === 0 ? 100 : (capturedCount / eligible.length) * 100;

  return {
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    eligibleTransactionCount: eligible.length,
    capturedRecordCount: capturedCount,
    coveragePercentage: Math.round(coveragePercentage * 100) / 100,
    missedTransactions: missed.map((row) => ({
      transactionId: row.id,
      amount: Number(row.amount),
      createdAt: row.created_at.toISOString(),
    })),
    correctiveActionsTaken: [],
    generatedAt: new Date().toISOString(),
  };
}

/** Serializes a report to CSV — summary header followed by missed transactions. */
export function travelRuleAuditReportToCsv(report: TravelRuleAuditReport): string {
  const lines = [
    "# Travel Rule Compliance Audit Report",
    `# Period,${report.periodStart},${report.periodEnd}`,
    `# EligibleTransactions,${report.eligibleTransactionCount}`,
    `# CapturedRecords,${report.capturedRecordCount}`,
    `# CoveragePercentage,${report.coveragePercentage}`,
    `# GeneratedAt,${report.generatedAt}`,
    "",
    "transactionId,amount,createdAt",
    ...report.missedTransactions.map(
      (t) => `${t.transactionId},${t.amount},${t.createdAt}`,
    ),
  ];
  return lines.join("\n");
}

/** Renders a report as a PDF buffer for regulatory review/export. */
export async function travelRuleAuditReportToPdf(
  report: TravelRuleAuditReport,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", (err) => reject(err));

    doc.fillColor("#2c3e50").fontSize(18).text("Travel Rule Compliance Audit Report", {
      align: "center",
    });
    doc.moveDown(1);

    doc.fillColor("#34495e").fontSize(12).text("Summary", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor("#000");
    doc.text(`Period: ${report.periodStart} to ${report.periodEnd}`);
    doc.text(`Eligible Transactions: ${report.eligibleTransactionCount}`);
    doc.text(`Captured Records: ${report.capturedRecordCount}`);
    doc.text(`Coverage: ${report.coveragePercentage}%`);
    doc.text(`Generated At: ${report.generatedAt}`);

    doc.moveDown(1);
    doc.fillColor("#34495e").fontSize(12).text("Missed Transactions", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor("#000");

    if (report.missedTransactions.length === 0) {
      doc.text("None — full coverage for this period.");
    } else {
      for (const t of report.missedTransactions) {
        doc.text(`${t.transactionId}  |  ${t.amount}  |  ${t.createdAt}`);
      }
    }

    doc.moveDown(1);
    doc.fillColor("#34495e").fontSize(12).text("Corrective Actions Taken", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor("#000");
    doc.text(
      report.correctiveActionsTaken.length === 0
        ? "None recorded."
        : report.correctiveActionsTaken.join("\n"),
    );

    doc.end();
  });
}

/** Returns the [start, end) bounds of the calendar month prior to `reference`. */
export function previousMonthRange(reference: Date): { start: Date; end: Date } {
  const start = new Date(
    Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() - 1, 1),
  );
  const end = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), 1));
  return { start, end };
}
