# Runbook 12: Unmatched Reconciliation Investigation & Resolution

**Status:** Production | **Severity:** P2 (High) / P1 (if systemic) | **Audience:** Operations & Support Staff

---

## 1. Overview & Context

Reconciliation jobs run daily across external payment providers (Mobile Money networks, Stellar Horizon) and compare internal ledger entries with provider settlement reports.

When discrepancies occur, reconciliation alerts are raised with severities (`low`, `medium`, `high`, `critical`) and flagged as unmatched.

> **CRITICAL RULE**: Support staff must NEVER manually modify financial state via ad-hoc SQL `UPDATE` or `DELETE` statements on `transactions`, `ledger_entries`, or `balances`. All investigations must be read-only and audited.

---

## 2. Symptoms & Triggers

- `Daily Provider Reconciliation` job logs:
  - `Found X critical and Y high priority alerts requiring review`
  - `Found Z transactions older than 7 days without reconciliation`
  - Match rate dropped below 99.5%
- PagerDuty or Slack alert: `[ReconciliationAlert] Critical: Unmatched transaction detected`

---

## 3. Discrepancy Types

| Discrepancy Code | Description | Typical Cause |
| :--- | :--- | :--- |
| `NOT_FOUND_IN_SYSTEM` | Transaction exists in provider report but missing locally | Dropped callback, timeout before DB commit |
| `NOT_FOUND_IN_PROVIDER` | Transaction marked success locally but absent in provider statement | Delayed settlement cut-off, provider batch delay |
| `AMOUNT_MISMATCH` | Internal amount differs from provider cleared amount | Fee deduction mismatch, FX slippage |
| `STATUS_MISMATCH` | Internal status (e.g. `completed`) differs from provider (e.g. `failed`) | Reversal or late failure on provider side |
| `FEE_MISMATCH` | Discrepancy in network/interchange fee calculation | Tariff schedule update on provider |

---

## 4. Safe Investigation Steps (Read-Only)

Support staff should execute the read-only investigation tool:

```bash
# Safely inspect all open reconciliation alerts without modifying state
npm run momo-cli -- reconciliation alerts --severity=critical

# Or run the investigation utility:
tsx src/scripts/investigate-unmatched-reconciliation.ts --days=3
```

### Safe SQL Queries (Read Replica Only)

Run these queries **only against the read replica** (`DATABASE_READ_URL`):

```sql
-- 1. Check open critical and high reconciliation alerts
SELECT id, provider, alert_type, severity, reference_number, transaction_id, created_at
FROM reconciliation_alerts
WHERE status = 'open' AND severity IN ('critical', 'high')
ORDER BY created_at DESC;

-- 2. Inspect the local transaction record
SELECT id, reference_number, status, amount, fee, provider, created_at, updated_at
FROM transactions
WHERE id = '<transaction_id>' OR reference_number = '<ref_number>';

-- 3. Check corresponding double-entry ledger postings
SELECT id, transaction_id, account_type, entry_type, amount, balance_after, created_at
FROM ledger_entries
WHERE transaction_id = '<transaction_id>'
ORDER BY created_at ASC;
```

---

## 5. Non-Destructive Remediation & Recovery

### Action A: Provider Delay (Wait & Re-Reconcile)
If the provider batch report had a late cut-off time:
1. Allow the provider's subsequent report batch to ingest.
2. Trigger a safe manual reconciliation replay for the target date:
   ```bash
   tsx -e 'import { runManualProviderReconciliation } from "./src/jobs/providerReconciliationJob"; runManualProviderReconciliation("mtn", new Date("YYYY-MM-DD"));'
   ```

### Action B: Disputed or Stalled Transaction
1. Transition transaction status through the authorized workflow service:
   - Mark for review using `transactionStatusWorkflowService.transition(txId, current, "FLAGGED_FOR_REVIEW")`.
2. Do NOT alter ledger accounts directly.

### Action C: Escalation Path
If amount mismatch exceeds \$500 or systemic `NOT_FOUND_IN_PROVIDER` occurs:
1. Escalate to Engineering on-call (#bridge-alerts).
2. Contact provider technical liaison with the external provider reference number and settlement report timestamp.

---

## 6. Verification Checklist

- [ ] Match rate restored to >= 99.8%.
- [ ] No unhandled P1/Critical reconciliation alerts remain in `reconciliation_alerts`.
- [ ] Double-entry ledger balance equation remains verified (`debits = credits`).
- [ ] All diagnostic actions logged in audit logs.
