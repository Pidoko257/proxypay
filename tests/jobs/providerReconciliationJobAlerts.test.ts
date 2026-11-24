import axios from "axios";
import { ReconciliationAlertNotifier } from "../../src/services/reconciliationAlertNotifier";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("ReconciliationAlertNotifier", () => {
  let notifier: ReconciliationAlertNotifier;
  let mockEmailService: { sendEmail: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    mockEmailService = {
      sendEmail: jest.fn().mockResolvedValue(undefined),
    };
    notifier = new ReconciliationAlertNotifier(mockEmailService as any);

    process.env.PAGERDUTY_INTEGRATION_KEY = "mock_pd_key";
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/mock";
    process.env.RECONCILIATION_ALERT_EMAIL = "alerts@company.internal";
  });

  afterEach(() => {
    delete process.env.PAGERDUTY_INTEGRATION_KEY;
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.RECONCILIATION_ALERT_EMAIL;
  });

  it("dispatches PagerDuty, Slack, and email notifications for critical alerts", async () => {
    mockedAxios.post.mockResolvedValue({ status: 200, data: {} });

    const alerts = [
      {
        id: "alert_01",
        provider: "mtn",
        alert_type: "AMOUNT_MISMATCH",
        severity: "critical",
        reference_number: "REF_001",
      },
      {
        id: "alert_02",
        provider: "orange",
        alert_type: "NOT_FOUND_IN_PROVIDER",
        severity: "high",
        reference_number: "REF_002",
      },
    ];

    const result = await notifier.notifyAlerts(alerts);

    expect(result.pagerDutyDispatched).toBe(1); // 1 critical alert
    expect(result.slackDispatched).toBe(true);
    expect(result.emailDispatched).toBe(true);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://events.pagerduty.com/v2/enqueue",
      expect.objectContaining({
        routing_key: "mock_pd_key",
        event_action: "trigger",
      }),
      expect.any(Object)
    );

    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://hooks.slack.com/services/mock",
      expect.objectContaining({
        text: expect.stringContaining("Provider Reconciliation Alerts Detected"),
      }),
      expect.any(Object)
    );

    expect(mockEmailService.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "alerts@company.internal",
        subject: expect.stringContaining("[Reconciliation Alert]"),
      })
    );
  });

  it("does not dispatch when there are only low or medium alerts", async () => {
    const alerts = [
      {
        id: "alert_03",
        provider: "mtn",
        alert_type: "METRIC_DRIFT",
        severity: "low",
      },
    ];

    const result = await notifier.notifyAlerts(alerts);

    expect(result.pagerDutyDispatched).toBe(0);
    expect(result.slackDispatched).toBe(false);
    expect(result.emailDispatched).toBe(false);
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(mockEmailService.sendEmail).not.toHaveBeenCalled();
  });

  it("handles third-party network failures gracefully without throwing errors", async () => {
    mockedAxios.post.mockRejectedValue(new Error("Network timeout"));
    mockEmailService.sendEmail.mockRejectedValue(new Error("SendGrid failure"));

    const alerts = [
      {
        id: "alert_04",
        provider: "mtn",
        alert_type: "UNMATCHED_RECONCILIATION",
        severity: "critical",
      },
    ];

    const result = await notifier.notifyAlerts(alerts);
    expect(result.pagerDutyDispatched).toBe(0);
    expect(result.slackDispatched).toBe(false);
    expect(result.emailDispatched).toBe(false);
  });
});
