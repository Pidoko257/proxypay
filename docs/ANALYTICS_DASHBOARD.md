# Analytics Dashboard - Complete Guide

## Overview

ProxyPay Analytics Dashboard provides comprehensive insights into user activity, transaction trends, and system health metrics. The system tracks every user action, aggregates data in real-time, and provides powerful analytics APIs for dashboards and reporting.

## Architecture

### Core Components

1. **Event Tracking** - Centralized event logging for all user actions
2. **Time-Series Aggregation** - Pre-aggregated daily and hourly metrics
3. **Cohort Analysis** - User segmentation and retention tracking
4. **Funnel Analysis** - Transaction flow conversion tracking
5. **Data Export** - CSV, JSON, and Parquet format export
6. **Query Optimization** - Redis caching and materialized views

## Database Schema

### Tables

**analytics_events** (Primary event log)
- event_type: login, transaction, kyc, deposit, withdraw, error
- event_category: user_action, system, transaction, security, compliance
- Flexible JSONB properties for custom data
- Indexed by: user_id, timestamp, event_type, session_id

**analytics_daily_metrics** (Pre-aggregated daily data)
- Active users, new users, returning users
- Transaction counts and volumes
- Deposits/withdrawals breakdown
- KYC metrics
- Platform breakdown (web, mobile, API)

**analytics_hourly_metrics** (High-resolution recent data)
- Active users per hour
- Transactions and volume
- Error counts
- Response time metrics

**analytics_cohorts & analytics_cohort_members**
- User segmentation by behavior/acquisition date
- Retention tracking (day 1, 7, 30, 90)

**analytics_funnels & analytics_funnel_events**
- Conversion tracking through transaction steps
- Abandonment analysis

**analytics_segments** - Dynamic user segments

**analytics_query_cache** - Query result caching for sub-second response

**analytics_exports** - Export tracking and management

### Materialized Views

- `mv_transaction_daily_stats` - Daily transaction statistics
- `mv_user_activity_metrics` - Daily user activity

## API Endpoints

All endpoints require authentication and admin authorization.

### Dashboard

```
GET /api/analytics/dashboard?period=today|week|month
```

Returns:
```json
{
  "success": true,
  "data": {
    "activeUsers": 1250,
    "uniqueSessions": 2100,
    "totalTransactions": 4500,
    "successfulTransactions": 4350,
    "totalVolume": 125000.50,
    "errorCount": 42,
    "kycEvents": 230,
    "countriesActive": 15,
    "successRate": 96.67
  }
}
```

### Transaction Trends

```
GET /api/analytics/transactions/trends?startDate=2026-07-01&endDate=2026-07-31
```

Returns time-series data:
```json
{
  "success": true,
  "data": [
    {
      "date": "2026-07-31",
      "count": 450,
      "volume": 12500.75,
      "successRate": 97.5,
      "avgDuration": 2345
    }
  ]
}
```

### Cohort Analysis

```
GET /api/analytics/cohorts?cohortId=optional
```

Returns cohort metrics with retention curves:
```json
{
  "success": true,
  "data": [
    {
      "cohortId": "uuid",
      "cohortName": "July 2026 Acquisition",
      "created": "2026-07-01",
      "userCount": 5000,
      "retention": {
        "day1": 4800,
        "day7": 3200,
        "day30": 1800,
        "day90": 950
      }
    }
  ]
}
```

### Create Cohort

```
POST /api/analytics/cohorts
{
  "name": "High-Value Users",
  "type": "behavior",
  "definition": {
    "criteria": "volume > 10000 AND retention_day7 = true"
  }
}
```

### Funnel Analysis

```
GET /api/analytics/funnels?funnelId=optional
```

Returns funnel steps and conversion rates:
```json
{
  "success": true,
  "data": [
    {
      "funnelName": "Deposit Flow",
      "steps": [
        {
          "name": "Initiate Deposit",
          "count": 1000,
          "conversionRate": 100,
          "avgDuration": 1500
        },
        {
          "name": "Verify Amount",
          "count": 950,
          "conversionRate": 95,
          "avgDuration": 800
        },
        {
          "name": "Confirm",
          "count": 900,
          "conversionRate": 94.7,
          "avgDuration": 600
        }
      ],
      "totalEntries": 1000,
      "completionRate": 90,
      "abandonmentRate": 10
    }
  ]
}
```

### Track Funnel Event

```
POST /api/analytics/funnels/track
{
  "funnelId": "uuid",
  "stepIndex": 1,
  "stepName": "Verify Amount",
  "status": "completed|abandoned",
  "reason": "optional abandonment reason"
}
```

### User Retention

```
GET /api/analytics/retention?startDate=2026-07-01&endDate=2026-07-31
```

Returns cohort-based retention:
```json
{
  "success": true,
  "data": [
    {
      "cohortDate": "2026-07-01",
      "cohortSize": 500,
      "retention": {
        "day0": 500,
        "day1": 450,
        "day7": 300,
        "day30": 180
      }
    }
  ]
}
```

### Data Export

```
GET /api/analytics/export?format=csv|json|parquet&startDate=...&endDate=...&eventType=...
```

Returns file download or JSON data

## Event Logging

### Log Single Event

```typescript
import { analyticsService } from '../services/analyticsService';

await analyticsService.logEvent({
  eventType: 'transaction',
  eventCategory: 'transaction',
  eventName: 'deposit_completed',
  userId: 'user-123',
  transactionId: 'txn-456',
  properties: {
    amount: 1000,
    provider: 'MTN',
    status: 'completed'
  },
  platform: 'web',
  country: 'CM'
});
```

### Log Batch Events

```typescript
await analyticsService.logEvents([
  {
    eventType: 'login',
    eventCategory: 'user_action',
    eventName: 'user_login',
    userId: 'user-123',
    platform: 'mobile'
  },
  // ... more events
]);
```

### Event Types

- **login** - User login
- **transaction** - Generic transaction
- **deposit** - Money deposit
- **withdraw** - Money withdrawal
- **kyc** - KYC status change
- **error** - System error
- **security** - Security event

## Performance Optimization

### Caching Strategy

1. **Redis Cache** (15 min - 1 hour)
   - Dashboard metrics
   - Transaction trends
   - Cohort data

2. **Materialized Views** (hourly refresh)
   - Daily transaction stats
   - User activity metrics

3. **Database Indexes** (10+ indexes)
   - Optimized for common queries
   - Composite indexes on frequent filter combinations

### Query Performance

- Dashboard queries: ~100ms (first request), <10ms (cached)
- Transaction trends: ~500ms (7-day range)
- Cohort analysis: ~200ms per cohort
- Funnel analysis: ~300ms per funnel

### Data Partitioning

Events table partitioned by month for:
- Faster queries on recent data
- Efficient archival of old data
- Parallel query execution

## Business Use Cases

### User Growth Analysis
```
GET /api/analytics/dashboard?period=month
// Track: new_users, active_users, retention curves
```

### Transaction Flow Optimization
```
GET /api/analytics/funnels
// Identify: drop-off points, avg duration per step
// Action: A/B test improvements, streamline UX
```

### Geographic Expansion
```
GET /api/analytics/dashboard
// Track: countries_active, regional transaction volume
// Identify: high-potential markets
```

### KYC Conversion
```
GET /api/analytics/cohorts
// Track: kyc approval rates, approved user behavior
// Identify: KYC completion bottlenecks
```

### Fraud Detection
```
POST /api/analytics/event (log suspicious patterns)
// Track: error_count, rapid transactions, unusual amounts
// Action: flag for manual review
```

## Integration Examples

### Dashboard Widget - Active Users

```javascript
const metrics = await fetch('/api/analytics/dashboard?period=today');
const data = await metrics.json();
console.log(data.data.activeUsers); // 1250
```

### Retention Tracking

```javascript
const retention = await fetch(
  '/api/analytics/retention?startDate=2026-07-01&endDate=2026-07-31'
);
const cohorts = await retention.json();
// Plot retention curves for each cohort
```

### Export for External BI

```javascript
const csv = await fetch(
  '/api/analytics/export?format=csv&startDate=2026-07-01&endDate=2026-07-31'
);
// Send to Tableau, Looker, or Power BI
```

## Maintenance

### Refresh Materialized Views

```bash
# Automatic: Hourly via cron job
# Manual trigger:
curl -X POST /api/analytics/refresh \
  -H "Authorization: Bearer $TOKEN"
```

### Archive Old Events

```typescript
// Archive events older than 90 days
const archived = await analyticsService.archiveOldEvents(90);
console.log(`Archived ${archived} events`);
```

### Query Performance Tuning

Monitor slow queries:
```bash
# Check PostgreSQL slow query log
SELECT query, calls, mean_time 
FROM pg_stat_statements 
ORDER BY mean_time DESC;
```

## Alerts and Monitoring

### System Health Metrics

- Event ingestion lag: < 5 seconds
- Query response time: < 1 second (p95)
- Cache hit rate: > 80%
- Data freshness: < 1 hour

### Alerts to Set

- Event ingestion lagging > 60s
- Query response time > 5s
- Cache hit rate < 50%
- Error rate > 1% of transactions

## Security & Privacy

- Admin-only access to analytics APIs
- PII data redaction in exports
- Audit logging of all data access
- GDPR-compliant data retention policies
- Encryption of cached sensitive data

## Future Enhancements

- Real-time streaming analytics
- ML-based anomaly detection
- Predictive churn modeling
- A/B testing framework
- Custom metric definitions
- Automated report generation
- Slack/email alert integration
