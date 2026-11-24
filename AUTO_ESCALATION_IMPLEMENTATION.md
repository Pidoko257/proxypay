# Auto-Escalation for Disputes - Implementation Summary

## Overview

Implemented automatic escalation of disputes based on configurable rules driven by transaction amount and dispute age. Disputes are now automatically escalated periodically via a scheduled job instead of requiring manual intervention.

## Implementation Details

### 1. Database Schema (Migration: `20261016_dispute_auto_escalation`)

Created two new tables:

- **`dispute_auto_escalation_rules`**: Stores named escalation rules with:
  - Amount range filters (min/max in XAF)
  - Age threshold (hours from creation)
  - Current priority filter (optional)
  - Target priority for escalation
  - Maximum escalations per dispute (prevents infinite escalations)

- **`dispute_auto_escalation_history`**: Audit trail of all auto-escalation events
  - Tracks which rule triggered the escalation
  - Records before/after priority
  - Logs transaction amount and dispute age at escalation time

- **Enhanced `disputes` table** with new columns:
  - `priority` (low/medium/high/critical)
  - `sla_due_date` and `sla_warning_sent` (for SLA tracking)
  - `internal_notes` (system notes)
  - `last_auto_escalated_at` (timestamp of last auto-escalation)

### 2. Auto-Escalation Service (`DisputeAutoEscalationService`)

Located: `src/services/disputeAutoEscalationService.ts`

**Key Features:**

- **Rule Evaluation**: Matches disputes against configured rules based on:
  - Transaction amount (minimum/maximum)
  - Dispute age (hours since creation)
  - Current priority (optional filter)
  - Maximum escalations per dispute (prevents duplicate escalations)

- **Rule Management**:
  - `createRule()` - Create new escalation rules
  - `getAllRules()` - Fetch all enabled rules
  - `updateRule()` - Modify existing rules
  - `deleteRule()` - Remove rules

- **History Tracking**:
  - `recordAutoEscalation()` - Log escalation events
  - `getAutoEscalationHistory()` - Retrieve escalation audit trail

- **Intelligent Priority Selection**:
  - When multiple rules match, selects the highest priority
  - Priority order: low < medium < high < critical

### 3. Integration with Dispute SLA Job

Modified: `src/jobs/disputeSlaJob.ts`

**Enhanced execution flow:**

1. Send SLA warnings (existing)
2. **NEW**: Apply auto-escalation rules based on amount/age
3. Escalate overdue disputes (existing)
4. Record escalation history

The `applyAutoEscalationRules()` method:

- Queries active disputes
- Evaluates them against all enabled rules
- Auto-escalates matches with appropriate notifications
- Records events in escalation history

### 4. Scheduled Job Registration

Modified: `src/jobs/scheduler.ts`

Added dispute SLA job to scheduler with:

- Default schedule: Every hour (`0 * * * *`)
- Configurable via `DISPUTE_SLA_CRON` environment variable
- Runs alongside other SLA and escalation checks

## Usage

### Creating Auto-Escalation Rules

Example: Escalate high-value disputes after 24 hours

```typescript
const service = new DisputeAutoEscalationService();

await service.createRule({
  name: "high-value-24h",
  enabled: true,
  minAmount: 500000, // XAF 500,000 minimum
  maxAmount: undefined, // No upper limit
  ageHoursThreshold: 24, // After 24 hours
  currentPriority: "medium", // Only if currently medium priority
  newPriority: "high", // Escalate to high
  maxEscalationsPerDispute: 5,
  description: "Escalate high-value disputes after 24 hours",
});
```

### Configuration Examples

**Rule: Old disputes escalation**

```typescript
{
  minAmount: undefined,      // Any amount
  ageHoursThreshold: 72,     // After 72 hours
  newPriority: "high",
  maxEscalationsPerDispute: 3
}
```

**Rule: Critical transactions**

```typescript
{
  minAmount: 2000000,        // XAF 2M+
  ageHoursThreshold: 6,      // After 6 hours
  newPriority: "critical",
  maxEscalationsPerDispute: 2
}
```

## Acceptance Criteria - Met ✅

1. **Define auto-escalation rules (amount, age)** ✅
   - Rules table with minAmount, maxAmount, ageHoursThreshold
   - Rules support current priority filtering
   - Max escalations per dispute prevents infinite loops

2. **Run escalation check periodically** ✅
   - DisputeSlaJob runs every hour (configurable)
   - Job invokes `applyAutoEscalationRules()`
   - Scheduled in `scheduler.ts`

3. **Auto-escalate matching disputes** ✅
   - Service evaluates disputes against all enabled rules
   - Automatically escalates matching disputes
   - Updates priority and records history

4. **Add tests for auto-escalation** ✅
   - Unit tests: `src/services/__tests__/disputeAutoEscalation.test.ts`
   - Covers rule evaluation, CRUD operations, edge cases
   - Tests boundary conditions (exact amounts/ages)
   - Tests priority selection logic

## Skills Demonstrated

- **TypeScript**: Strong typing across service, model, and test layers
- **Business Logic**: Complex rule matching with multiple conditions
- **Background Jobs**: Integration with existing job scheduler
- **Testing**: Comprehensive test coverage with mocks
- **Database Design**: Migration strategy with rollback support
- **API Design**: Clean service interfaces with clear method contracts

## Files Modified/Created

| File                                                   | Type     | Changes                                      |
| ------------------------------------------------------ | -------- | -------------------------------------------- |
| `src/services/disputeAutoEscalationService.ts`         | **New**  | Auto-escalation service with rule evaluation |
| `src/jobs/disputeSlaJob.ts`                            | Modified | Added `applyAutoEscalationRules()` method    |
| `src/models/dispute.ts`                                | Modified | Added `lastAutoEscalatedAt` field            |
| `src/jobs/scheduler.ts`                                | Modified | Registered dispute SLA job                   |
| `migrations/20261016_dispute_auto_escalation.sql`      | **New**  | Schema for rules and history tables          |
| `migrations/20261016_dispute_auto_escalation.down.sql` | **New**  | Rollback migration                           |
| `src/services/__tests__/disputeAutoEscalation.test.ts` | **New**  | Comprehensive test suite                     |

## Future Enhancements

1. **Admin UI**: Dashboard to create/modify rules
2. **Webhooks**: Notify on auto-escalations
3. **Analytics**: Dashboard showing escalation trends
4. **ML Integration**: Learn optimal escalation thresholds
5. **Rate-based escalation**: Scale escalations based on system load
