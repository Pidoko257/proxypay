# Quick Start - Automatic Dispute Escalation

## 30-Second Setup

### 1. Run Migration

```bash
npm run migrate:up
```

### 2. Create Your First Rule

```sql
INSERT INTO dispute_auto_escalation_rules (
  name, enabled, min_amount, age_hours_threshold, new_priority, description
) VALUES (
  'urgent-high-value',
  true,
  1000000,     -- XAF 1M+
  12,          -- After 12 hours
  'critical',  -- Escalate to critical
  'Critical escalation for 1M+ disputes after 12 hours'
);
```

### 3. Done! ✅

The job automatically runs every hour and escalates matching disputes.

## Verify It's Working

### Check the Logs

```
[DisputeSlaJob] Starting SLA monitoring job...
[DisputeSlaJob] Auto-escalated dispute abc-123: medium → critical
[DisputeSlaJob] Job completed: { autoEscalated: 1, ... }
```

### Query Recent Escalations

```sql
SELECT d.id, d.priority, h.old_priority, h.new_priority, h.created_at
FROM disputes d
JOIN dispute_auto_escalation_history h ON h.dispute_id = d.id
ORDER BY h.created_at DESC
LIMIT 10;
```

## Common Rules

### Rule: Age-Based Escalation

```sql
INSERT INTO dispute_auto_escalation_rules (
  name, enabled, age_hours_threshold, new_priority, max_escalations_per_dispute, description
) VALUES (
  'ancient-disputes',
  true,
  168,          -- 1 week
  'critical',
  2,
  'Escalate any dispute over a week old'
);
```

### Rule: High-Value with Priority Check

```sql
INSERT INTO dispute_auto_escalation_rules (
  name, enabled, min_amount, age_hours_threshold, current_priority, new_priority, description
) VALUES (
  'high-value-medium-to-high',
  true,
  500000,       -- XAF 500K+
  48,           -- 2 days
  'medium',     -- Only if currently medium
  'high',
  'Escalate 500K+ medium-priority disputes after 48 hours'
);
```

### Rule: Critical Transactions

```sql
INSERT INTO dispute_auto_escalation_rules (
  name, enabled, min_amount, age_hours_threshold, new_priority, max_escalations_per_dispute, description
) VALUES (
  'critical-txns',
  true,
  5000000,      -- XAF 5M+
  6,            -- 6 hours
  'critical',
  1,            -- Can only escalate once
  'XAF 5M+ transactions escalate immediately'
);
```

## Key Points

✅ **Runs automatically** - No manual intervention needed
✅ **Configurable** - Create rules directly in database
✅ **Smart matching** - Multiple rules supported, picks highest priority
✅ **Safe** - Prevents infinite escalations with max_escalations_per_dispute
✅ **Audited** - Full history of all escalations recorded
✅ **Fast** - Rules cached, efficient matching

## Control the Schedule

```bash
# Every 30 minutes
DISPUTE_SLA_CRON="*/30 * * * *"

# Every 2 hours
DISPUTE_SLA_CRON="0 */2 * * *"

# At 1 AM and 1 PM every day
DISPUTE_SLA_CRON="0 1,13 * * *"
```

## Disable/Enable Rules

```sql
-- Disable a rule
UPDATE dispute_auto_escalation_rules
SET enabled = FALSE
WHERE name = 'urgent-high-value';

-- Enable it again
UPDATE dispute_auto_escalation_rules
SET enabled = TRUE
WHERE name = 'urgent-high-value';
```

## Troubleshooting

**Q: Rules not escalating?**

- Check enabled = TRUE
- Verify amount is in range
- Check dispute age >= threshold
- Look at logs for errors

**Q: Rule matched but no escalation?**

- Check max_escalations_per_dispute limit
- Verify currentPriority matches if set
- Check last_auto_escalated_at (prevents rapid re-escalations)

**Q: Need more details?**

- See AUTO_ESCALATION_IMPLEMENTATION.md
- See AUTO_ESCALATION_USAGE_GUIDE.md

## Support

All files are documented:

- Implementation details: `AUTO_ESCALATION_IMPLEMENTATION.md`
- Comprehensive guide: `AUTO_ESCALATION_USAGE_GUIDE.md`
- Complete checklist: `IMPLEMENTATION_CHECKLIST.md`
