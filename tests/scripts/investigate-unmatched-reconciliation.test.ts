import {
  classifyAlertAction,
  formatInvestigationReport,
  ReconciliationAlertItem,
} from "../../src/scripts/investigate-unmatched-reconciliation";

describe("investigate-unmatched-reconciliation", () => {
  describe("classifyAlertAction", () => {
    it("flags AMOUNT_MISMATCH for engineering escalation and prevents manual DB edits", () => {
      const action = classifyAlertAction("AMOUNT_MISMATCH", "critical");
      expect(action.requiresEngineeringEscalation).toBe(true);
      expect(action.safeForSupportSelfService).toBe(false);
      expect(action.recommendedAction).toContain("Verify provider settlement hash");
    });

    it("guides safe callback check for NOT_FOUND_IN_SYSTEM", () => {
      const action = classifyAlertAction("NOT_FOUND_IN_SYSTEM", "medium");
      expect(action.recommendedAction).toContain("Do NOT insert manual records");
      expect(action.safeForSupportSelfService).toBe(true);
    });

    it("recommends cut-off check for NOT_FOUND_IN_PROVIDER", () => {
      const action = classifyAlertAction("NOT_FOUND_IN_PROVIDER", "high");
      expect(action.recommendedAction).toContain("Verify provider settlement report cut-off time");
    });

    it("guides workflow transition for STATUS_MISMATCH", () => {
      const action = classifyAlertAction("STATUS_MISMATCH", "medium");
      expect(action.recommendedAction).toContain("TransactionStatusWorkflowService");
    });
  });

  describe("formatInvestigationReport", () => {
    it("formats clean report with summary and action items", () => {
      const alerts: ReconciliationAlertItem[] = [
        {
          id: "alert-1",
          provider: "mtn",
          alert_type: "AMOUNT_MISMATCH",
          severity: "critical",
          reference_number: "REF-1234",
          created_at: new Date().toISOString(),
        },
      ];

      const report = formatInvestigationReport(alerts, 3);
      expect(report).toContain("Open Critical/High Alerts: 1");
      expect(report).toContain("Unreconciled Transactions (>7d): 3");
      expect(report).toContain("Escalate: YES");
    });
  });
});
