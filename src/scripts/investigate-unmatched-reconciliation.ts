import logger from "../utils/logger";

export interface ReconciliationAlertItem {
  id: string;
  provider: string;
  alert_type: string;
  severity: "low" | "medium" | "high" | "critical";
  reference_number?: string;
  transaction_id?: string;
  details?: Record<string, any>;
  created_at: string;
}

export interface InvestigationAction {
  recommendedAction: string;
  requiresEngineeringEscalation: boolean;
  safeForSupportSelfService: boolean;
}

/**
 * Categorize a reconciliation alert and guide support staff on safe, read-only
 * diagnosis without modifying financial records directly.
 */
export function classifyAlertAction(alertType: string, severity: string): InvestigationAction {
  const normType = alertType.toUpperCase();
  const isCritical = severity.toLowerCase() === "critical";

  if (normType.includes("AMOUNT_MISMATCH") || normType.includes("LEDGER_IMBALANCE")) {
    return {
      recommendedAction:
        "Verify provider settlement hash against local transaction amount; escalate to finance/engineering if discrepancy > $50.",
      requiresEngineeringEscalation: true,
      safeForSupportSelfService: false,
    };
  }

  if (normType.includes("NOT_FOUND_IN_SYSTEM")) {
    return {
      recommendedAction:
        "Check callback logs and inbound webhook DLQ for dropped transaction events. Do NOT insert manual records.",
      requiresEngineeringEscalation: isCritical,
      safeForSupportSelfService: !isCritical,
    };
  }

  if (normType.includes("NOT_FOUND_IN_PROVIDER")) {
    return {
      recommendedAction:
        "Verify provider settlement report cut-off time. If within batch latency window, queue next cycle check; otherwise flag for provider liaison.",
      requiresEngineeringEscalation: isCritical,
      safeForSupportSelfService: true,
    };
  }

  if (normType.includes("STATUS_MISMATCH")) {
    return {
      recommendedAction:
        "Inspect provider transaction state history. Transition transaction via TransactionStatusWorkflowService if verified.",
      requiresEngineeringEscalation: false,
      safeForSupportSelfService: true,
    };
  }

  return {
    recommendedAction: "Review alert diagnostic context and monitor for systemic pattern.",
    requiresEngineeringEscalation: isCritical,
    safeForSupportSelfService: true,
  };
}

export function formatInvestigationReport(
  alerts: ReconciliationAlertItem[],
  unreconciledCount: number
): string {
  let report = `=== ProxyPay Reconciliation Support Investigation ===\n\n`;
  report += `Open Critical/High Alerts: ${alerts.length}\n`;
  report += `Unreconciled Transactions (>7d): ${unreconciledCount}\n\n`;

  if (alerts.length === 0) {
    report += `No high-severity reconciliation alerts detected.\n`;
    return report;
  }

  report += `Actionable Guidance:\n`;
  for (const alert of alerts) {
    const action = classifyAlertAction(alert.alert_type, alert.severity);
    report += `- [${alert.severity.toUpperCase()}] ${alert.provider} (${alert.reference_number || alert.id}):\n`;
    report += `  Issue: ${alert.alert_type}\n`;
    report += `  Safe Action: ${action.recommendedAction}\n`;
    report += `  Escalate: ${action.requiresEngineeringEscalation ? "YES" : "No"}\n\n`;
  }

  return report;
}

if (require.main === module) {
  logger.info("[Reconciliation Investigation] Running read-only diagnostics for support staff...");
}
