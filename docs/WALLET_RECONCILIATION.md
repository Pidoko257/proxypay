# Wallet Balance Reconciliation System

## Overview

The ProxyPay Wallet Balance Reconciliation System automatically compares ProxyPay ledger balances with Stellar blockchain account balances, detecting and alerting on discrepancies in real-time. The system features:

- **Hourly Reconciliation**: Automated jobs run every hour to check all user wallets
- **Discrepancy Detection**: Identifies ledger vs. blockchain mismatches
- **Automatic Correction**: Can auto-correct ledger errors within configured thresholds
- **Multi-channel Alerts**: Sends alerts via email, Slack, PagerDuty, SMS, and webhooks
- **Admin Dashboard**: Real-time metrics and historical reporting
- **Manual Reconciliation**: Admin tools for investigating and resolving discrepancies
- **Audit Trail**: Complete history of all actions and corrections

## Architecture

### Core Components

1. **WalletReconciliationService** - Main reconciliation logic
   - Fetches user ledger balances from ProxyPay database
   - Fetches account balances from Stellar blockchain
   - Compares balances and detects discrepancies
   - Triggers auto-corrections when enabled

2. **ReconciliationQueue** - BullMQ job processor
   - Manages hourly scheduled reconciliation jobs
   - Handles job retry logic and failure recovery
   - Provides queue monitoring and job status

3. **DiscrepancyAlertService** - Alert dispatcher
   - Detects critical vs. non-critical discrepancies
   - Routes alerts to configured channels
   - Implements severity-based escalation

4. **ReconciliationReportService** - Reporting engine
   - Generates detailed reports by time period
   - Provides dashboard metrics
   - Creates charts and distribution data
   - Exports to CSV for auditing

5. **AdminReconciliationService** - Admin operations
   - Approve/reject discrepancy corrections
   - Apply custom adjustments
   - Bulk operations on discrepancies
   - Health status monitoring
   - Pattern detection for suspicious activity

## Database Schema

### reconciliation_jobs
Tracks each reconciliation job run:
- Status: pending, in_progress, completed, failed, partial
- Metrics: total accounts, successful checks, discrepancies found
- Auto-corrections and manual reviews needed
- Duration and error tracking

### wallet_discrepancies
Detailed record of each detected discrepancy:
- User/wallet identification
- Ledger vs. Stellar balance comparison
- Discrepancy type (ledger_surplus/deficit)
- Status tracking (pending → investigating → resolved)
- Severity classification (critical, high, medium, low)
- Possible causes analysis
- Manual review and resolution notes

### account_balance_snapshots
Periodic snapshots for audit trail:
- Ledger, Stellar, and vault balance snapshots
- Recent transaction activity
- Reconciliation status at time of snapshot

### stellar_transaction_verifications
Verification tracking for Stellar transactions:
- Transaction hash and operation details
- Status and confirmation tracking
- Discrepancy flagging

### reconciliation_settings
Configuration for reconciliation behavior:
- Thresholds for discrepancy detection and alerts
- Auto-correction settings and limits
- Alert channel configuration
- Performance and batch settings

## API Endpoints

### Admin Endpoints

#### POST /api/reconciliation/trigger
Manually trigger a reconciliation job

```bash
curl -X POST http://localhost:3000/api/reconciliation/trigger \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"jobType": "stellar_ledger", "priority": "high"}'
```

#### GET /api/reconciliation/dashboard
Get real-time dashboard metrics

```bash
curl http://localhost:3000/api/reconciliation/dashboard \
  -H "Authorization: Bearer <jwt>"
```

Response:
```json
{
  "success": true,
  "data": {
    "pendingDiscrepancies": 5,
    "resolvedDiscrepancies": 127,
    "criticalDiscrepancies": 2,
    "lastReconciliationTime": "2026-07-29T09:50:00Z",
    "lastReconciliationStatus": "completed",
    "autoCorrectionsToday": 12,
    "averageReconciliationTime": 45,
    "discrepancyDetectionRate": 25.5
  }
}
```

#### GET /api/reconciliation/report
Generate report for period

```bash
curl 'http://localhost:3000/api/reconciliation/report?startDate=2026-07-01&endDate=2026-07-31' \
  -H "Authorization: Bearer <jwt>"
```

#### GET /api/reconciliation/report/csv
Export report as CSV file

```bash
curl 'http://localhost:3000/api/reconciliation/report/csv?startDate=2026-07-01&endDate=2026-07-31' \
  -H "Authorization: Bearer <jwt>" \
  -o reconciliation-report.csv
```

#### GET /api/reconciliation/discrepancies
List pending discrepancies

```bash
curl 'http://localhost:3000/api/reconciliation/discrepancies?limit=100' \
  -H "Authorization: Bearer <jwt>"
```

#### PUT /api/reconciliation/discrepancies/:id/approve
Approve a discrepancy correction

```bash
curl -X PUT http://localhost:3000/api/reconciliation/discrepancies/{id}/approve \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"notes": "Approved after manual review"}'
```

#### PUT /api/reconciliation/discrepancies/:id/reject
Reject a discrepancy correction

```bash
curl -X PUT http://localhost:3000/api/reconciliation/discrepancies/{id}/reject \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Requires further investigation"}'
```

#### POST /api/reconciliation/bulk-approve
Bulk approve pending discrepancies

```bash
curl -X POST http://localhost:3000/api/reconciliation/bulk-approve \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"limit": 50}'
```

#### GET /api/reconciliation/health
Check system health status

```bash
curl http://localhost:3000/api/reconciliation/health \
  -H "Authorization: Bearer <jwt>"
```

Response:
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "summary": "All systems operational",
    "pendingCount": 5,
    "criticalCount": 0,
    "queue": {
      "waiting": 0,
      "active": 1,
      "completed": 42,
      "failed": 0,
      "delayed": 0
    }
  }
}
```

#### GET /api/reconciliation/suspicious-patterns
Detect suspicious activity patterns

```bash
curl http://localhost:3000/api/reconciliation/suspicious-patterns \
  -H "Authorization: Bearer <jwt>"
```

#### GET /api/reconciliation/charts/history
Get historical chart data (default 30 days)

```bash
curl 'http://localhost:3000/api/reconciliation/charts/history?days=30' \
  -H "Authorization: Bearer <jwt>"
```

#### GET /api/reconciliation/charts/severity
Get severity distribution

```bash
curl http://localhost:3000/api/reconciliation/charts/severity \
  -H "Authorization: Bearer <jwt>"
```

#### GET /api/reconciliation/charts/types
Get discrepancy type distribution

```bash
curl http://localhost:3000/api/reconciliation/charts/types \
  -H "Authorization: Bearer <jwt>"
```

## Configuration

Add to `.env`:

```bash
# Reconciliation Settings
RECONCILIATION_ENABLED=true
RECONCILIATION_INTERVAL_HOURS=1
RECONCILIATION_CONCURRENCY=2
RECONCILIATION_BATCH_SIZE=100

# Discrepancy Thresholds (USD)
RECONCILIATION_THRESHOLD_USD=1.00
RECONCILIATION_CRITICAL_THRESHOLD_USD=1000.00

# Auto-Correction Settings
RECONCILIATION_AUTO_CORRECT_ENABLED=false
RECONCILIATION_AUTO_CORRECT_MAX_AMOUNT=100.00
RECONCILIATION_AUTO_CORRECT_LEDGER_ONLY=true

# Alert Settings
RECONCILIATION_ALERT_ENABLED=true
RECONCILIATION_ALERT_CHANNELS=slack,email
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
PAGERDUTY_TOKEN=your-pagerduty-token

# Database
DATABASE_URL=postgresql://user:pass@localhost/proxypay
REDIS_URL=redis://localhost:6379
```

## Reconciliation Flow

```
1. Hourly Job Triggered
   ↓
2. Fetch All Users with Stellar Wallets
   ↓
3. For Each User:
   a. Get Ledger Balance (from DB)
   b. Get Stellar Balance (from blockchain)
   c. Compare Balances
   d. If Mismatch:
      - Create Discrepancy Record
      - Determine Severity
      - Identify Possible Causes
      - Auto-Correct if Enabled
      - Alert if Above Threshold
   ↓
4. Generate Job Summary
   ↓
5. Update Job Status
   ↓
6. Alert on Critical Issues
```

## Discrepancy Types

### Ledger Surplus
Ledger has MORE funds than blockchain
- Possible causes:
  - Duplicate transaction recorded
  - Manual adjustment not reflected on blockchain
  - Pending transaction not yet confirmed
  - Ledger entry error

### Ledger Deficit
Ledger has FEWER funds than blockchain
- Possible causes:
  - Blockchain transaction not recorded in ledger
  - Transaction reversal or clawback
  - Fee collection
  - Network error during recording

## Severity Levels

| Severity | Amount Range | Alert Behavior |
|----------|--------------|---|
| Critical | > $10,000 | Immediate alerts via PagerDuty, Slack, email |
| High | $1,000 - $10,000 | Alert via Slack and email |
| Medium | $100 - $1,000 | Email alert |
| Low | < $100 | Logged only |

## Alert Channels

### Email
Sends detailed email alert to configured recipients

### Slack
Posts formatted message to Slack channel with color-coded severity

### PagerDuty
Triggers incident for critical discrepancies

### SMS
Sends concise alert via SMS for critical issues

### Webhook
POSTs alert data to configured webhook endpoints

## Manual Reconciliation

Admins can manually trigger reconciliation for specific users:

```bash
# Trigger manual reconciliation
curl -X POST http://localhost:3000/api/reconciliation/trigger \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"jobType": "user_wallet", "userId": "user-123", "priority": "high"}'
```

## Admin Actions

### Approve Discrepancy
Mark discrepancy as resolved after manual review:
```bash
curl -X PUT http://localhost:3000/api/reconciliation/discrepancies/{id}/approve \
  -H "Authorization: Bearer <jwt>" \
  -d '{"notes": "Verified and approved"}'
```

### Reject Discrepancy
Request further investigation:
```bash
curl -X PUT http://localhost:3000/api/reconciliation/discrepancies/{id}/reject \
  -H "Authorization: Bearer <jwt>" \
  -d '{"reason": "Amount seems incorrect, needs review"}'
```

### Bulk Approve
Approve multiple pending discrepancies at once:
```bash
curl -X POST http://localhost:3000/api/reconciliation/bulk-approve \
  -H "Authorization: Bearer <jwt>" \
  -d '{"limit": 50}'
```

## Dashboard Metrics

The dashboard provides real-time visibility into system health:

- **Pending Discrepancies**: Count of discrepancies awaiting review
- **Critical Discrepancies**: Count of high-severity unresolved issues
- **Last Reconciliation**: When last job completed and its status
- **Auto-Corrections Today**: Count of automatically corrected issues
- **Average Reconciliation Time**: Performance metric in seconds
- **Discrepancy Detection Rate**: % of jobs finding issues

## Reports

### Period Report
Comprehensive report for date range including:
- Total jobs run
- Total discrepancies found
- Auto-corrections and manual reviews
- Average resolution time
- Distribution by severity and type
- Top affected users
- Total discrepancy amount

### CSV Export
Machine-readable export for:
- Spreadsheet analysis
- External audit systems
- Compliance documentation
- Historical archival

## Health Monitoring

System monitors for issues:

- **Job Failures**: 3+ consecutive failures triggers alert
- **Queue Backlog**: Too many pending jobs
- **Resolution Time**: Average time exceeds threshold
- **Suspicious Patterns**: Recurring issues for same user/account
- **Critical Discrepancies**: Any unresolved critical issues

## Troubleshooting

### Discrepancies Not Detected
1. Check if reconciliation is enabled: `RECONCILIATION_ENABLED=true`
2. Verify Stellar account configuration
3. Check database connectivity
4. Review logs for errors

### False Positives (Incorrect Discrepancies)
1. Adjust threshold: `RECONCILIATION_THRESHOLD_USD`
2. Review possible causes list
3. Check for pending transactions not yet confirmed
4. Investigate timing issues

### Alerts Not Sending
1. Verify alert channels configured: `RECONCILIATION_ALERT_CHANNELS`
2. Check Slack webhook URL
3. Verify PagerDuty token
4. Review alert settings thresholds

### Auto-Correction Issues
1. Enable only for ledger_surplus: `RECONCILIATION_AUTO_CORRECT_LEDGER_ONLY=true`
2. Set conservative max amount: `RECONCILIATION_AUTO_CORRECT_MAX_AMOUNT`
3. Monitor corrections in audit trail
4. Disable if causing issues: `RECONCILIATION_AUTO_CORRECT_ENABLED=false`

## Performance Considerations

- **Batch Size**: Process users in batches (default: 100)
- **Concurrency**: Run multiple checks in parallel (default: 2)
- **Caching**: Stellar balance queries cached for 30 seconds
- **Indexing**: Database indexes optimized for common queries
- **Archive**: Old discrepancies archive after retention period

## Security

- Admin-only access to reconciliation endpoints
- All actions logged in audit trail
- Role-based authorization (admin, super-admin)
- Sensitive data encrypted at rest
- Rate limiting on API endpoints

## Future Enhancements

- [ ] Custom alert rules per user
- [ ] Machine learning for anomaly detection
- [ ] Predictive alerts based on patterns
- [ ] Integration with external audit systems
- [ ] Automated dispute filing
- [ ] Multi-asset reconciliation
- [ ] Cross-chain reconciliation
- [ ] Real-time streaming updates via WebSocket

## Testing

Run test suite:
```bash
npm test -- wallet-reconciliation.test.ts
```

Test coverage includes:
- Edge cases for balance comparison
- Severity calculation boundaries
- Concurrent reconciliation scenarios
- Auto-correction logic
- Report generation
- Alert system
- Admin operations
- Data consistency
