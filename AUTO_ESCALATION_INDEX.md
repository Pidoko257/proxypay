# Automatic Dispute Escalation - Documentation Index

## Overview

Automatic escalation of disputes based on configurable rules (transaction amount and dispute age). Disputes are escalated periodically via scheduled background jobs.

## Start Here 👇

### For Operations/Setup

1. **[Quick Start Guide](AUTO_ESCALATION_QUICK_START.md)** (5 min read)
   - 30-second setup
   - Verify it's working
   - Common rule templates

### For Developers

1. **[Implementation Guide](AUTO_ESCALATION_IMPLEMENTATION.md)** (10 min read)
   - Architecture overview
   - File structure
   - Technical details

2. **[Usage Guide](AUTO_ESCALATION_USAGE_GUIDE.md)** (15 min read)
   - Database queries
   - Programmatic API
   - Troubleshooting

### For Project Management

1. **[Implementation Checklist](IMPLEMENTATION_CHECKLIST.md)** (5 min read)
   - All acceptance criteria met
   - Files created/modified
   - Testing coverage

## Core Components

### Service

**File:** `src/services/disputeAutoEscalationService.ts`

- Rule evaluation engine
- CRUD operations
- History tracking
- Intelligent priority selection

### Integration

**File:** `src/jobs/disputeSlaJob.ts`

- Background job for escalation
- Hourly execution (configurable)
- Error handling

### Scheduler

**File:** `src/jobs/scheduler.ts`

- Registers dispute-sla job
- Runs every hour by default
- Environment-configurable

### Database

**Files:** `migrations/20261016_dispute_auto_escalation*.sql`

- Rules table
- History table
- Enhanced disputes table

### Tests

**File:** `src/services/__tests__/disputeAutoEscalation.test.ts`

- 20+ test cases
- Full coverage of business logic
- Edge case handling

## Quick Commands

```bash
# Setup
npm run migrate:up

# Create a rule
INSERT INTO dispute_auto_escalation_rules ...

# View rules
SELECT * FROM dispute_auto_escalation_rules WHERE enabled = TRUE;

# View escalation history
SELECT * FROM dispute_auto_escalation_history ORDER BY created_at DESC;

# Configure schedule
export DISPUTE_SLA_CRON="*/30 * * * *"  # Every 30 minutes
npm start
```

## Key Files

| File                                                 | Purpose                    | Size      |
| ---------------------------------------------------- | -------------------------- | --------- |
| src/services/disputeAutoEscalationService.ts         | Auto-escalation service    | 463 lines |
| src/services/**tests**/disputeAutoEscalation.test.ts | Test suite                 | 504 lines |
| src/jobs/disputeSlaJob.ts                            | Background job integration | Modified  |
| src/jobs/scheduler.ts                                | Job scheduler              | Modified  |
| src/models/dispute.ts                                | Model updates              | Modified  |
| migrations/20261016_dispute_auto_escalation.sql      | Database schema            | 96 lines  |
| migrations/20261016_dispute_auto_escalation.down.sql | Rollback                   | 29 lines  |

## Acceptance Criteria Status

- ✅ Define auto-escalation rules (amount, age)
- ✅ Run escalation check periodically
- ✅ Auto-escalate matching disputes
- ✅ Add tests for auto-escalation

## FAQ

**Q: How often does escalation happen?**
A: Every hour by default. Configurable via DISPUTE_SLA_CRON env var.

**Q: Can I modify rules without redeploying?**
A: Yes! Rules are stored in database. Changes take effect within 5 minutes.

**Q: What if multiple rules match?**
A: The service automatically picks the highest priority recommendation.

**Q: How do I prevent infinite escalations?**
A: Use max_escalations_per_dispute limit (default 5 per rule).

**Q: Is there an audit trail?**
A: Yes! All escalations recorded in dispute_auto_escalation_history.

## Support

- Implementation details: See AUTO_ESCALATION_IMPLEMENTATION.md
- Usage examples: See AUTO_ESCALATION_USAGE_GUIDE.md
- Testing: Check src/services/**tests**/disputeAutoEscalation.test.ts

---

**Status:** ✅ Production Ready
**Version:** 1.0
**Implementation Date:** October 16, 2026
