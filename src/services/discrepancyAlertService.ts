import { walletDiscrepancyModel, reconciliationSettingsModel, type WalletDiscrepancy } from "../models/reconciliation";
import logger from "../utils/logger";

export interface DiscrepancyAlert {
  discrepancyId: string;
  severity: string;
  amount: number;
  userId?: string;
  message: string;
  detailedInfo: Record<string, any>;
}

export enum AlertChannel {
  EMAIL = "email",
  SLACK = "slack",
  PAGERDUTY = "pagerduty",
  SMS = "sms",
  WEBHOOK = "webhook",
}

/**
 * Discrepancy Alert Service
 * 
 * Handles detection and alerting of wallet balance discrepancies
 */
export class DiscrepancyAlertService {
  /**
   * Alert on discrepancy
   */
  async alertOnDiscrepancy(discrepancy: WalletDiscrepancy): Promise<void> {
    try {
      const settings = await reconciliationSettingsModel.getSettings();

      if (!settings.alertEnabled) {
        logger.debug(`[Alerts] Alerts disabled, skipping discrepancy ${discrepancy.id}`);
        return;
      }

      // Only alert if discrepancy exceeds threshold
      if (Math.abs(discrepancy.discrepancyAmount) < settings.discrepancyThresholdUsd) {
        logger.debug(
          `[Alerts] Discrepancy ${discrepancy.id} below threshold, skipping alert`,
        );
        return;
      }

      const alert = this.buildAlert(discrepancy);

      // Send to configured channels
      for (const channel of settings.alertChannels) {
        try {
          await this.sendAlert(alert, channel as AlertChannel, settings.alertRecipients);
        } catch (err) {
          logger.error(`[Alerts] Failed to send alert via ${channel}: ${err}`);
        }
      }

      logger.info(`[Alerts] Alert sent for discrepancy ${discrepancy.id}`);
    } catch (error) {
      logger.error(`[Alerts] Failed to alert on discrepancy: ${error}`);
    }
  }

  /**
   * Alert on critical discrepancy
   */
  async alertCriticalDiscrepancy(discrepancy: WalletDiscrepancy): Promise<void> {
    try {
      const settings = await reconciliationSettingsModel.getSettings();

      // Check if above critical threshold
      if (Math.abs(discrepancy.discrepancyAmount) > settings.criticalThresholdUsd) {
        const alert = this.buildAlert(discrepancy);
        alert.message = `⚠️ CRITICAL: ${alert.message}`;

        // Send to all channels with immediate priority
        for (const channel of ["pagerduty", "slack", "email"]) {
          try {
            await this.sendAlert(
              alert,
              channel as AlertChannel,
              settings.alertRecipients,
              true,
            );
          } catch (err) {
            logger.error(`[Alerts] Failed to send critical alert via ${channel}: ${err}`);
          }
        }

        logger.warn(
          `[Alerts] Critical alert sent for discrepancy ${discrepancy.id}`,
        );
      }
    } catch (error) {
      logger.error(`[Alerts] Failed to send critical alert: ${error}`);
    }
  }

  /**
   * Build alert from discrepancy
   */
  private buildAlert(discrepancy: WalletDiscrepancy): DiscrepancyAlert {
    return {
      discrepancyId: discrepancy.id,
      severity: discrepancy.severity || "medium",
      amount: discrepancy.discrepancyAmount,
      userId: discrepancy.userId,
      message: this.buildAlertMessage(discrepancy),
      detailedInfo: {
        walletAddress: discrepancy.walletAddress,
        ledgerBalance: discrepancy.ledgerBalance,
        stellarBalance: discrepancy.stellarBalance,
        discrepancyType: discrepancy.discrepancyType,
        assetCode: discrepancy.assetCode,
        possibleCauses: discrepancy.possibleCauses,
        status: discrepancy.status,
      },
    };
  }

  /**
   * Build human-readable alert message
   */
  private buildAlertMessage(discrepancy: WalletDiscrepancy): string {
    let type = "";
    if (discrepancy.discrepancyType === "ledger_surplus") {
      type = "Ledger has more funds than blockchain";
    } else if (discrepancy.discrepancyType === "ledger_deficit") {
      type = "Ledger has fewer funds than blockchain";
    }

    return `${type}: ${Math.abs(discrepancy.discrepancyAmount).toFixed(2)} ${discrepancy.assetCode || "XLM"}`;
  }

  /**
   * Send alert via channel
   */
  private async sendAlert(
    alert: DiscrepancyAlert,
    channel: AlertChannel,
    recipients: string[],
    immediate: boolean = false,
  ): Promise<void> {
    switch (channel) {
      case AlertChannel.EMAIL:
        await this.sendEmailAlert(alert, recipients);
        break;

      case AlertChannel.SLACK:
        await this.sendSlackAlert(alert, immediate);
        break;

      case AlertChannel.PAGERDUTY:
        await this.sendPagerDutyAlert(alert, immediate);
        break;

      case AlertChannel.SMS:
        await this.sendSmsAlert(alert, recipients);
        break;

      case AlertChannel.WEBHOOK:
        await this.sendWebhookAlert(alert, recipients);
        break;

      default:
        logger.warn(`[Alerts] Unknown alert channel: ${channel}`);
    }
  }

  /**
   * Send email alert
   */
  private async sendEmailAlert(alert: DiscrepancyAlert, recipients: string[]): Promise<void> {
    logger.debug(`[Alerts] Sending email alert to ${recipients.join(", ")}`);

    // TODO: Integrate with email service
    const subject = `[ProxyPay] Wallet Balance Discrepancy Alert (${alert.severity.toUpperCase()})`;
    const body = `
      Discrepancy ID: ${alert.discrepancyId}
      Severity: ${alert.severity}
      Message: ${alert.message}
      Amount: ${alert.amount}
      
      Details:
      ${JSON.stringify(alert.detailedInfo, null, 2)}
    `;

    logger.info(`[Alerts] Email alert body:\n${body}`);
  }

  /**
   * Send Slack alert
   */
  private async sendSlackAlert(alert: DiscrepancyAlert, immediate: boolean = false): Promise<void> {
    logger.debug(`[Alerts] Sending Slack alert${immediate ? " (urgent)" : ""}`);

    const slackWebhook = process.env.SLACK_WEBHOOK_URL;
    if (!slackWebhook) {
      logger.warn("[Alerts] SLACK_WEBHOOK_URL not configured");
      return;
    }

    const color = alert.severity === "critical" ? "danger" : "warning";
    const payload = {
      attachments: [
        {
          color,
          title: `Wallet Balance Discrepancy - ${alert.severity.toUpperCase()}`,
          text: alert.message,
          fields: [
            {
              title: "Discrepancy ID",
              value: alert.discrepancyId,
              short: true,
            },
            {
              title: "Amount",
              value: `${alert.amount.toFixed(2)} XLM`,
              short: true,
            },
            {
              title: "Wallet",
              value: alert.detailedInfo.walletAddress,
              short: true,
            },
            {
              title: "Type",
              value: alert.detailedInfo.discrepancyType,
              short: true,
            },
            {
              title: "Possible Causes",
              value: (alert.detailedInfo.possibleCauses || []).join(", ") || "Unknown",
              short: false,
            },
          ],
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    };

    try {
      // TODO: Send to Slack
      logger.debug(`[Alerts] Slack payload: ${JSON.stringify(payload)}`);
    } catch (error) {
      logger.error(`[Alerts] Failed to send Slack alert: ${error}`);
      throw error;
    }
  }

  /**
   * Send PagerDuty alert
   */
  private async sendPagerDutyAlert(alert: DiscrepancyAlert, immediate: boolean = false): Promise<void> {
    logger.debug(`[Alerts] Sending PagerDuty alert${immediate ? " (urgent)" : ""}`);

    const pagerDutyToken = process.env.PAGERDUTY_TOKEN;
    if (!pagerDutyToken) {
      logger.warn("[Alerts] PAGERDUTY_TOKEN not configured");
      return;
    }

    const severity = alert.severity === "critical" ? "critical" : "warning";

    const payload = {
      routing_key: pagerDutyToken,
      event_action: "trigger",
      dedup_key: alert.discrepancyId,
      payload: {
        summary: alert.message,
        severity,
        source: "ProxyPay Reconciliation",
        custom_details: alert.detailedInfo,
      },
    };

    try {
      // TODO: Send to PagerDuty
      logger.debug(`[Alerts] PagerDuty payload: ${JSON.stringify(payload)}`);
    } catch (error) {
      logger.error(`[Alerts] Failed to send PagerDuty alert: ${error}`);
      throw error;
    }
  }

  /**
   * Send SMS alert
   */
  private async sendSmsAlert(alert: DiscrepancyAlert, recipients: string[]): Promise<void> {
    logger.debug(`[Alerts] Sending SMS alert to ${recipients.join(", ")}`);

    const message = `ProxyPay Alert: ${alert.message} (ID: ${alert.discrepancyId.slice(0, 8)})`;

    // TODO: Integrate with SMS service
    logger.info(`[Alerts] SMS message: ${message}`);
  }

  /**
   * Send webhook alert
   */
  private async sendWebhookAlert(alert: DiscrepancyAlert, recipients: string[]): Promise<void> {
    logger.debug(`[Alerts] Sending webhook alert to ${recipients.join(", ")}`);

    for (const webhookUrl of recipients) {
      try {
        // TODO: Send webhook
        logger.debug(`[Alerts] Would POST to ${webhookUrl}`);
      } catch (error) {
        logger.error(`[Alerts] Failed to send webhook alert to ${webhookUrl}: ${error}`);
      }
    }
  }

  /**
   * Bulk alert on discrepancies
   */
  async alertOnMultipleDiscrepancies(discrepancies: WalletDiscrepancy[]): Promise<void> {
    logger.info(`[Alerts] Processing ${discrepancies.length} discrepancies for alerts`);

    for (const discrepancy of discrepancies) {
      if (discrepancy.severity === "critical") {
        await this.alertCriticalDiscrepancy(discrepancy);
      } else {
        await this.alertOnDiscrepancy(discrepancy);
      }
    }
  }
}

export const discrepancyAlertService = new DiscrepancyAlertService();
