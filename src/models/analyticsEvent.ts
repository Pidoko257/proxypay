import { queryRead, queryWrite } from "../config/database";
import { v4 as uuidv4 } from "uuid";

export type EventType = "login" | "transaction" | "kyc" | "deposit" | "withdraw" | "error" | "security";
export type EventCategory = "user_action" | "system" | "transaction" | "security" | "compliance";

export interface AnalyticsEvent {
  id: string;
  eventId?: string;
  eventType: EventType;
  eventCategory: EventCategory;
  eventName: string;
  userId?: string;
  transactionId?: string;
  sessionId?: string;
  properties?: Record<string, any>;
  platform?: string;
  ipAddress?: string;
  userAgent?: string;
  country?: string;
  dimension1?: string;
  dimension2?: string;
  dimension3?: string;
  value?: number;
  durationMs?: number;
  eventTimestamp: Date;
  createdAt: Date;
}

export interface DailyMetrics {
  metricDate: Date;
  activeUsers: number;
  newUsers: number;
  returningUsers: number;
  totalTransactions: number;
  totalVolume: number;
  successfulTxns: number;
  failedTxns: number;
  depositCount: number;
  depositVolume: number;
  withdrawCount: number;
  withdrawVolume: number;
  kycSubmitted: number;
  kycApproved: number;
  kycRejected: number;
  loginCount: number;
  errorCount: number;
  avgSessionDuration?: number;
  countriesActive: number;
  webUsers: number;
  mobileUsers: number;
  apiCalls: number;
}

export class AnalyticsEventModel {
  async createEvent(data: Omit<AnalyticsEvent, "id" | "createdAt" | "eventTimestamp">): Promise<AnalyticsEvent> {
    const eventId = data.eventId || uuidv4();

    const result = await queryWrite(
      `INSERT INTO analytics_events (
         event_id, event_type, event_category, event_name, user_id, transaction_id,
         session_id, properties, platform, ip_address, user_agent, country,
         dimension_1, dimension_2, dimension_3, value, duration_ms, event_timestamp
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING *`,
      [
        eventId,
        data.eventType,
        data.eventCategory,
        data.eventName,
        data.userId || null,
        data.transactionId || null,
        data.sessionId || null,
        data.properties ? JSON.stringify(data.properties) : null,
        data.platform || null,
        data.ipAddress || null,
        data.userAgent || null,
        data.country || null,
        data.dimension1 || null,
        data.dimension2 || null,
        data.dimension3 || null,
        data.value || null,
        data.durationMs || null,
        new Date(),
      ],
    );

    return this.mapRow(result.rows[0]);
  }

  async bulkCreateEvents(events: Array<Omit<AnalyticsEvent, "id" | "createdAt" | "eventTimestamp">>): Promise<number> {
    if (events.length === 0) return 0;

    const values: any[] = [];
    const placeholders: string[] = [];

    events.forEach((event, index) => {
      const baseIndex = index * 17 + 1;
      placeholders.push(
        `($${baseIndex}, $${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7}, $${baseIndex + 8}, $${baseIndex + 9}, $${baseIndex + 10}, $${baseIndex + 11}, $${baseIndex + 12}, $${baseIndex + 13}, $${baseIndex + 14}, $${baseIndex + 15}, $${baseIndex + 16})`,
      );

      values.push(
        event.eventId || uuidv4(),
        event.eventType,
        event.eventCategory,
        event.eventName,
        event.userId || null,
        event.transactionId || null,
        event.sessionId || null,
        event.properties ? JSON.stringify(event.properties) : null,
        event.platform || null,
        event.ipAddress || null,
        event.userAgent || null,
        event.country || null,
        event.dimension1 || null,
        event.dimension2 || null,
        event.dimension3 || null,
        event.value || null,
        event.durationMs || null,
      );
    });

    const query = `INSERT INTO analytics_events (
      event_id, event_type, event_category, event_name, user_id, transaction_id, session_id,
      properties, platform, ip_address, user_agent, country, dimension_1, dimension_2, dimension_3,
      value, duration_ms, event_timestamp
    ) VALUES ${placeholders.join(", ")} ON CONFLICT (event_id) DO NOTHING`;

    const result = await queryWrite(query, values);
    return result.rowCount || 0;
  }

  async getEventsByUser(userId: string, limit: number = 1000, offset: number = 0): Promise<AnalyticsEvent[]> {
    const result = await queryRead(
      `SELECT * FROM analytics_events 
       WHERE user_id = $1 
       ORDER BY event_timestamp DESC 
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );

    return result.rows.map((row) => this.mapRow(row));
  }

  async getEventsByDateRange(startDate: Date, endDate: Date, eventType?: string): Promise<AnalyticsEvent[]> {
    let query = `SELECT * FROM analytics_events 
                 WHERE event_timestamp >= $1 AND event_timestamp < $2`;
    const params: any[] = [startDate, endDate];

    if (eventType) {
      query += ` AND event_type = $3`;
      params.push(eventType);
    }

    query += ` ORDER BY event_timestamp DESC LIMIT 10000`;

    const result = await queryRead(query, params);
    return result.rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: any): AnalyticsEvent {
    return {
      id: row.id,
      eventId: row.event_id,
      eventType: row.event_type,
      eventCategory: row.event_category,
      eventName: row.event_name,
      userId: row.user_id,
      transactionId: row.transaction_id,
      sessionId: row.session_id,
      properties: row.properties ? JSON.parse(row.properties) : undefined,
      platform: row.platform,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      country: row.country,
      dimension1: row.dimension_1,
      dimension2: row.dimension_2,
      dimension3: row.dimension_3,
      value: row.value ? parseFloat(row.value) : undefined,
      durationMs: row.duration_ms,
      eventTimestamp: new Date(row.event_timestamp),
      createdAt: new Date(row.created_at),
    };
  }
}

export const analyticsEventModel = new AnalyticsEventModel();
