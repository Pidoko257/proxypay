import axios from "axios";
import logger from "../utils/logger";
import { EmailService } from "./email";

export interface AlertNotificationItem {
  id?: string;
  provider?: string;
  alert_type: string;
  severity: "critical" | "high" | "medium" | "low" | string;
  reference_number?: string;
  transaction_id?: string;
  [key: string]: any;
}

export interface AlertNotificationSummary {
  pagerDutyDispatched: number;
  slackDispatched: boolean;
  emailDispatched: boolean;
}

export class ReconciliationAlertNotifier {
  private emailService: EmailService;

  constructor(emailService?: EmailService) {
    this.emailService = emailService || new EmailService();
  }

  /**
   * Dispatch notifications across PagerDuty, Slack, and Email for critical/high alerts.
   */
  public async notifyAlerts(alerts: AlertNotificationItem[]): Promise<AlertNotificationSummary> {
    const summary: AlertNotificationSummary = {
      pagerDutyDispatched: 0,
      slackDispatched: false,
      emailDispatched: false,
    };

    if (!alerts || alerts.length === 0) {
      return summary;
    }

    const criticals = alerts.filter((a) => a.severity.toLowerCase() === "critical");
    const highs = alerts.filter((a) => a.severity.toLowerCase() === "high");

    if (criticals.length === 0 && highs.length === 0) {
      return summary;
    }

    // 1. Dispatch PagerDuty Events for critical alerts
    const pdIntegrationKey =
      process.env.PAGERDUTY_INTEGRATION_KEY || process.env.RECONCILIATION_PAGERDUTY_KEY;
    if (pdIntegrationKey && criticals.length > 0) {
      for (const alert of criticals) {
        try {
          await axios.post(
            "https://events.pagerduty.com/v2/enqueue",
            {
              routing_key: pdIntegrationKey,
              event_action: "trigger",
              dedup_key: `reconciliation-${alert.provider || "generic"}-${alert.reference_number || alert.transaction_id || alert.id}`,
              payload: {
                summary: `[CRITICAL] Reconciliation Alert: ${alert.alert_type} (${alert.provider || "Unknown Provider"})`,
                severity: "critical",
                source: "providerReconciliationJob",
                timestamp: new Date().toISOString(),
                custom_details: alert,
              },
            },
            { timeout: 5000 }
          );
          summary.pagerDutyDispatched++;
        } catch (err: any) {
          logger.warn(`[ReconciliationNotifier] PagerDuty dispatch failed: ${err.message}`);
        }
      }
    }

    // 2. Dispatch Slack Webhook notification
    const slackWebhookUrl =
      process.env.SLACK_WEBHOOK_URL || process.env.RECONCILIATION_SLACK_WEBHOOK_URL;
    if (slackWebhookUrl) {
      try {
        const text =
          `🚨 *Provider Reconciliation Alerts Detected*\n- Critical Alerts: ${criticals.length}\n- High Alerts: ${highs.length}\n` +
          criticals
            .concat(highs)
            .slice(0, 5)
            .map(
              (a) =>
                `• [${a.severity.toUpperCase()}] ${a.provider || "Provider"}: ${a.alert_type} (Ref: ${a.reference_number || a.transaction_id || "N/A"})`
            )
            .join("\n");

        await axios.post(slackWebhookUrl, { text }, { timeout: 5000 });
        summary.slackDispatched = true;
      } catch (err: any) {
        logger.warn(`[ReconciliationNotifier] Slack dispatch failed: ${err.message}`);
      }
    }

    // 3. Dispatch Email notification
    const alertEmail = process.env.RECONCILIATION_ALERT_EMAIL || process.env.ADMIN_EMAIL;
    if (alertEmail) {
      try {
        await this.emailService.sendEmail({
          to: alertEmail,
          templateId:
            process.env.SENDGRID_RECONCILIATION_ALERT_TEMPLATE_ID || "reconciliation_alert",
          subject: `[Reconciliation Alert] ${criticals.length} Critical & ${highs.length} High Alerts`,
          text: `Daily reconciliation detected ${criticals.length} critical and ${highs.length} high priority alerts. Please review the dashboard.`,
          dynamicTemplateData: {
            criticalCount: criticals.length,
            highCount: highs.length,
            alerts: criticals.concat(highs).slice(0, 20),
          },
        });
        summary.emailDispatched = true;
      } catch (err: any) {
        logger.warn(`[ReconciliationNotifier] Email dispatch failed: ${err.message}`);
      }
    }

    return summary;
  }
}

export const reconciliationAlertNotifier = new ReconciliationAlertNotifier();
