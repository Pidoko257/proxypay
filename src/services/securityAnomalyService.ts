import { queryRead, queryWrite } from "../config/database";
import { emailService } from "./email";
import { hashString } from "../middleware/fingerprint";
import { getCurrentRequestIp } from "./logger";
import { randomUUID } from "crypto";

const GEOIP_API_KEY = process.env.GEOIP_API_KEY || "";

export type SecurityEventType = 
  | "new_country_login"
  | "new_ip_api_key_usage"
  | "bulk_operation_unusual_hours"
  | "high_risk_country_access"
  | "multiple_failed_logins";

export type SecurityEventSeverity = "low" | "medium" | "high" | "critical";

export interface SecurityEvent {
  id: string;
  userId?: string;
  apiKeyId?: string;
  eventType: SecurityEventType;
  severity: SecurityEventSeverity;
  ipAddress?: string;
  countryCode?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  acknowledged: boolean;
  acknowledgedAt?: Date;
  createdAt: Date;
}

interface AccountBaseline {
  userId: string;
  countries: string[];
  ipAddresses: string[];
  typicalHours: Record<string, number>;
  lastUpdated: Date;
}

interface ActivityRecord {
  userId: string;
  ipAddress: string;
  countryCode?: string;
  createdAt: Date;
}

const SUSPICIOUS_COUNTRIES = ["KP", "IR", "SY", "CU"];
const UNUSUAL_HOURS_START = 2;
const UNUSUAL_HOURS_END = 5;

function generateApprovalToken(): string {
  return randomUUID();
}

export class SecurityAnomalyService {
  private static approvalTokens = new Map<string, { userId: string; eventName: string }>();

  async getSecurityEvents(userId: string, limit = 100): Promise<SecurityEvent[]> {
    const result = await queryRead<SecurityEvent>(
      `SELECT id, user_id as "userId", api_key_id as "apiKeyId", event_type as "eventType", 
       severity, ip_address as "ipAddress", country_code as "countryCode", 
       user_agent as "userAgent", metadata, acknowledged, created_at as "createdAt"
       FROM security_events 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows.map(row => ({
      ...row,
      createdAt: new Date(row.createdAt),
      acknowledgedAt: row.acknowledgedAt ? new Date(row.acknowledgedAt) : undefined,
    }));
  }

  async getAllSecurityEvents(limit = 100): Promise<SecurityEvent[]> {
    const result = await queryRead<SecurityEvent>(
      `SELECT id, user_id as "userId", api_key_id as "apiKeyId", event_type as "eventType", 
       severity, ip_address as "ipAddress", country_code as "countryCode", 
       user_agent as "userAgent", metadata, acknowledged, created_at as "createdAt"
       FROM security_events 
       ORDER BY created_at DESC 
       LIMIT $1`,
      [limit]
    );
    return result.rows.map(row => ({
      ...row,
      createdAt: new Date(row.createdAt),
    }));
  }

  async createSecurityEvent(event: {
    userId?: string;
    apiKeyId?: string;
    eventType: SecurityEventType;
    severity: SecurityEventSeverity;
    ipAddress?: string;
    countryCode?: string;
    userAgent?: string;
    metadata?: Record<string, unknown>;
  }): Promise<SecurityEvent> {
    const result = await queryWrite<SecurityEvent>(
      `INSERT INTO security_events (user_id, api_key_id, event_type, severity, ip_address, country_code, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, user_id as "userId", api_key_id as "apiKeyId", event_type as "eventType",
                 severity, ip_address as "ipAddress", country_code as "countryCode",
                 user_agent as "userAgent", metadata, acknowledged, created_at as "createdAt"`,
      [
        event.userId || null,
        event.apiKeyId || null,
        event.eventType,
        event.severity,
        event.ipAddress || null,
        event.countryCode || null,
        event.userAgent || null,
        JSON.stringify(event.metadata || {}),
      ]
    );
    return { ...result.rows[0], createdAt: new Date(result.rows[0].createdAt) };
  }

  async acknowledgeEvent(eventId: string, acknowledgedBy?: string): Promise<void> {
    await queryWrite(
      `UPDATE security_events SET acknowledged = true, acknowledged_at = NOW(), acknowledged_by = $2 
       WHERE id = $1`,
      [eventId, acknowledgedBy || null]
    );
  }

  async getAccountBaseline(userId: string): Promise<AccountBaseline | null> {
    const result = await queryRead<AccountBaseline>(
      `SELECT user_id as "userId", countries, ip_addresses as "ipAddresses", 
       typical_hours as "typicalHours", last_updated as "lastUpdated"
       FROM account_activity_baseline WHERE user_id = $1`,
      [userId]
    );
    if (!result.rows[0]) return null;
    return { ...result.rows[0], lastUpdated: new Date(result.rows[0].lastUpdated) };
  }

  async updateAccountBaseline(baseline: Partial<AccountBaseline> & { userId: string }): Promise<void> {
    await queryWrite(
      `INSERT INTO account_activity_baseline (user_id, countries, ip_addresses, typical_hours)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) 
       DO UPDATE SET countries = $2, ip_addresses = $3, typical_hours = $4, last_updated = NOW()`,
      [
        baseline.userId,
        baseline.countries || [],
        baseline.ipAddresses || [],
        JSON.stringify(baseline.typicalHours || {}),
      ]
    );
  }

  async buildBaselineFromHistory(userId: string): Promise<AccountBaseline> {
    const result = await queryRead<ActivityRecord>(
      `SELECT user_id as "userId", ip_address as "ipAddress", country_code as "countryCode", created_at as "createdAt"
       FROM user_sessions 
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'
       UNION ALL
       SELECT user_id as "userId", ip_address as "ipAddress", NULL as "countryCode", created_at as "createdAt"
       FROM transactions
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'`,
      [userId]
    );

    const records = result.rows;
    const countries = [...new Set(records.map(r => r.countryCode).filter(Boolean))];
    const ipAddresses = [...new Set(records.map(r => r.ipAddress).filter(Boolean))];
    
    const hourCounts: Record<string, number> = {};
    for (let i = 0; i < 24; i++) hourCounts[i] = 0;
    records.forEach(r => {
      const hour = new Date(r.createdAt).getHours();
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    });

    const baseline: AccountBaseline = {
      userId,
      countries: countries as string[],
      ipAddresses: ipAddresses as string[],
      typicalHours: hourCounts,
      lastUpdated: new Date(),
    };

    await this.updateAccountBaseline(baseline);
    return baseline;
  }

  async detectLoginAnomaly(
    userId: string, 
    ipAddress: string, 
    userAgent?: string
  ): Promise<{ isAnomaly: boolean; event?: SecurityEvent }> {
    const baseline = await this.getAccountBaseline(userId);
    
    if (!baseline) {
      await this.buildBaselineFromHistory(userId);
      return { isAnomaly: false };
    }

    const ipAddresses = baseline.ipAddresses;
    const isNewIp = !ipAddresses.includes(ipAddress);

    if (isNewIp && ipAddresses.length > 0) {
      const event = await this.createSecurityEvent({
        userId,
        eventType: "new_ip_api_key_usage",
        severity: "medium",
        ipAddress,
        userAgent,
        metadata: { source: "login" },
      });

      const userResult = await queryRead<{ email: string }>(
        "SELECT email FROM users WHERE id = $1",
        [userId]
      );
      const userEmail = userResult.rows[0]?.email;

      if (userEmail) {
        const token = generateApprovalToken();
        SecurityAnomalyService.approvalTokens.set(token, { userId, eventName: "new_ip" });
        const approvalUrl = `${process.env.APP_URL || "https://app.proxypay.com"}/security/approve?token=${token}`;

        await emailService.sendEmail({
          to: userEmail,
          templateId: process.env.SENDGRID_SECURITY_ALERT_TEMPLATE_ID || "",
          dynamicTemplateData: {
            alertType: "new_ip",
            ipAddress,
            userAgent: userAgent || "unknown",
            approvalUrl,
            createdAt: new Date().toISOString(),
          },
        });
      }

      return { isAnomaly: true, event };
    }

    return { isAnomaly: false };
  }

  async detectCountryAnomaly(
    userId: string,
    ipAddress: string,
    countryCode: string,
    userAgent?: string
  ): Promise<{ isAnomaly: boolean; event?: SecurityEvent; requiresBlock?: boolean }> {
    const baseline = await this.getAccountBaseline(userId);
    
    const isSuspiciousCountry = SUSPICIOUS_COUNTRIES.includes(countryCode);
    const isNewCountry = !baseline?.countries.includes(countryCode);

    if (isSuspiciousCountry || isNewCountry) {
      const event = await this.createSecurityEvent({
        userId,
        eventType: "new_country_login",
        severity: isSuspiciousCountry ? "critical" : "high",
        ipAddress,
        countryCode,
        userAgent,
        metadata: { 
          source: "login",
          isSuspiciousCountry,
          action: isSuspiciousCountry ? "blocked" : "notified",
        },
      });

      const userResult = await queryRead<{ email: string }>(
        "SELECT email FROM users WHERE id = $1",
        [userId]
      );
      const userEmail = userResult.rows[0]?.email;

      if (userEmail) {
        const token = generateApprovalToken();
        SecurityAnomalyService.approvalTokens.set(token, { userId, eventName: "new_country" });
        const approvalUrl = `${process.env.APP_URL || "https://app.proxypay.com"}/security/approve?token=${token}`;
        const revokeUrl = `${process.env.APP_URL || "https://app.proxypay.com"}/security/revoke?token=${token}`;

        await emailService.sendEmail({
          to: userEmail,
          templateId: process.env.SENDGRID_SECURITY_ALERT_TEMPLATE_ID || "",
          dynamicTemplateData: {
            alertType: "new_country",
            countryCode,
            ipAddress,
            userAgent: userAgent || "unknown",
            approvalUrl,
            revokeUrl,
            requiresBlock: isSuspiciousCountry,
            createdAt: new Date().toISOString(),
          },
        });
      }

      return { 
        isAnomaly: true, 
        event, 
        requiresBlock: isSuspiciousCountry 
      };
    }

    return { isAnomaly: false };
  }

  async validateApprovalToken(token: string): Promise<{ valid: boolean; userId?: string }> {
    const data = SecurityAnomalyService.approvalTokens.get(token);
    if (!data) return { valid: false };
    return { valid: true, userId: data.userId };
  }

  async approveAnomaly(token: string): Promise<boolean> {
    const data = SecurityAnomalyService.approvalTokens.get(token);
    if (!data) return false;

    SecurityAnomalyService.approvalTokens.delete(token);
    return true;
  }

  async getCountryFromIp(ipAddress: string): Promise<string | null> {
    if (!GEOIP_API_KEY) return null;

    try {
      const normalizedIp = ipAddress.replace("::ffff:", "");
      const response = await fetch(
        `https://api.ipgeolocation.io/ipgeo?apiKey=${GEOIP_API_KEY}&ip=${normalizedIp}`
      );
      const data = await response.json();
      return data.country_code2 || null;
    } catch {
      return null;
    }
  }
}

export const securityAnomalyService = new SecurityAnomalyService();