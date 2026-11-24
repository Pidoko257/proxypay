# Auto-Escalation Rules - Quick Reference

## Database Queries

### View All Enabled Rules

```sql
SELECT * FROM dispute_auto_escalation_rules
WHERE enabled = TRUE
ORDER BY age_hours_threshold ASC;
```

### View Escalation History for a Dispute

```sql
SELECT
  h.dispute_id, r.name as rule_name, h.old_priority, h.new_priority,
  h.transaction_amount, h.age_hours, h.created_at
FROM dispute_auto_escalation_history h
JOIN dispute_auto_escalation_rules r ON r.id = h.rule_id
WHERE h.dispute_id = 'dispute-id-here'
ORDER BY h.created_at DESC;
```

### Create a Basic Rule (SQL)

```sql
INSERT INTO dispute_auto_escalation_rules (
  name, enabled, min_amount, max_amount, age_hours_threshold,
  current_priority, new_priority, max_escalations_per_dispute, description
) VALUES (
  'high-value-old-disputes',
  true,
  1000000,        -- XAF 1M minimum
  NULL,           -- No upper limit
  48,             -- 48 hours
  'medium',       -- Current priority must be medium
  'high',         -- Escalate to high
  3,              -- Max 3 escalations per dispute
  'Escalate medium-priority disputes over 1M after 48 hours'
);
```

## Programmatic Usage

### Import the Service

```typescript
import { DisputeAutoEscalationService } from "../services/disputeAutoEscalationService";

const service = new DisputeAutoEscalationService();
```

### Create a Rule

```typescript
const rule = await service.createRule({
  name: "urgent-high-value",
  enabled: true,
  minAmount: 2000000, // XAF 2M+
  ageHoursThreshold: 12, // After 12 hours
  newPriority: "critical",
  maxEscalationsPerDispute: 2,
  description: "Critical escalation for high-value disputes after 12 hours",
});
```

### Evaluate a Dispute

```typescript
const dispute = await disputeModel.findById(disputeId);
const transaction = await transactionModel.findById(dispute.transactionId);
const amount = parseFloat(transaction.amount);

const evaluation = await service.evaluateDispute(dispute, amount);

if (evaluation.shouldEscalate) {
  console.log(
    `Dispute matches rules: ${evaluation.matchingRules.map((r) => r.name).join(", ")}`,
  );
  console.log(`Recommended priority: ${evaluation.recommendedPriority}`);

  // Perform escalation...
}
```

### Get Rule History

```typescript
const history = await service.getAutoEscalationHistory(disputeId);
history.forEach((event) => {
  console.log(
    `${event.old_priority} → ${event.new_priority} via rule ${event.rule_id}`,
  );
});
```

### Update a Rule

```typescript
await service.updateRule(ruleId, {
  ageHoursThreshold: 36, // Changed from 48 to 36 hours
  newPriority: "critical", // Escalate higher
});
```

## Default Rules

None are pre-configured. Operators must create rules based on business needs.

### Recommended Starting Rules

**Rule 1: Emergency High-Value**

```sql
INSERT INTO dispute_auto_escalation_rules (
  name, enabled, min_amount, age_hours_threshold, new_priority,
  max_escalations_per_dispute, description
) VALUES (
  'emergency-high-value', true, 5000000, 6, 'critical', 1,
  'XAF 5M+ disputes escalate to critical after 6 hours'
);
```

**Rule 2: Medium Age Escalation**

```sql
INSERT INTO dispute_auto_escalation_rules (
  name, enabled, min_amount, age_hours_threshold,
  current_priority, new_priority, max_escalations_per_dispute, description
) VALUES (
  'aging-medium', true, 500000, 48, 'medium', 'high', 3,
  'XAF 500K+ medium-priority disputes escalate after 48 hours'
);
```

**Rule 3: Very Old Disputes**

```sql
INSERT INTO dispute_auto_escalation_rules (
  name, enabled, age_hours_threshold, new_priority,
  max_escalations_per_dispute, description
) VALUES (
  'ancient-escalation', true, 168, 'critical', 2,
  'Any dispute over a week old escalates to critical'
);
```

## Monitoring

### Check Job Execution

The job runs every hour and logs to console. Look for:

```
[DisputeSlaJob] Starting SLA monitoring job...
[DisputeSlaJob] Auto-escalated dispute dispute-id: medium → high
[DisputeSlaJob] Job completed: { warningsSent: 5, autoEscalated: 2, ... }
```

### Query Recent Escalations

```sql
SELECT COUNT(*) as escalations_today
FROM dispute_auto_escalation_history
WHERE created_at >= NOW() - INTERVAL '1 day';
```

### Find Disputes Hitting Max Escalations

```sql
SELECT
  dispute_id, COUNT(*) as escalation_count, MAX(created_at) as last_escalated
FROM dispute_auto_escalation_history
GROUP BY dispute_id
HAVING COUNT(*) >= 5  -- Adjust based on max_escalations_per_dispute
ORDER BY last_escalated DESC;
```

## Environment Variable

Control the job schedule with:

```bash
# Run every 30 minutes instead of hourly
DISPUTE_SLA_CRON="*/30 * * * *"

# Run every 2 hours
DISPUTE_SLA_CRON="0 */2 * * *"

# Run at specific times (e.g., every hour)
DISPUTE_SLA_CRON="0 * * * *"
```

## Troubleshooting

### Rule Not Matching

1. Verify rule is **enabled** = TRUE
2. Check amount is within range (>= min_amount and <= max_amount if set)
3. Check dispute age >= ageHoursThreshold
4. If currentPriority is set, verify dispute priority matches exactly
5. Check escalation count hasn't hit max_escalations_per_dispute

### Disputes Not Escalating

1. Verify DisputeSlaJob is scheduled (check logs)
2. Check if any disputes match rule criteria
3. Verify transactions have amounts populated
4. Check database connection for disputes table

### Performance Issues

Rules are cached for 5 minutes. To refresh:

```typescript
await service.invalidateCache();
```
