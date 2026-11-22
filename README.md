# Reconciliation Operations Runbook

This runbook is for support staff investigating reconciliation jobs. It explains what alerts mean, how to retrieve provider reports, which review actions are safe, how corrections are approved, how to replay a job, and who to escalate to.

> **Golden rule:** support staff must never manually change financial state (ledger entries, balances, transaction statuses, payouts). Investigation is read-only. Any correction goes through the approval workflow below.

## 1. Alert meanings

| Alert | Meaning | Typical cause |
| --- | --- | --- |
| `reconciliation.unmatched_transactions` | Provider report contains transactions with no matching internal record (or vice versa). | Timing lag, missing webhook, provider-side reversal, or a genuine discrepancy. |
| `reconciliation.critical_alert` | Reconciliation job failed or produced a discrepancy above the critical threshold. | Provider report unavailable, schema change, or a large unmatched balance. |
| `reconciliation.job_failed` | The reconciliation job did not complete. | Provider API outage, auth failure, or malformed report. |
| `reconciliation.stale_report` | No fresh provider report has been ingested within the expected window. | Provider delivery delay or ingestion pipeline issue. |

When an alert fires, note the alert type, job ID, provider, and time window before investigating.

## 2. Retrieving provider reconciliation reports

1. Open the **provider reconciliation dashboard**.
2. Select the provider and the reconciliation window referenced in the alert.
3. Download or view the provider report for that window. Confirm the report's generation timestamp and checksum if shown.
4. Compare the report against the internal reconciliation summary for the same window.
5. Record the report ID and window in the incident/audit trail so the investigation is traceable.

If the report is missing or stale, do not attempt to reconstruct it manually — escalate per section 6.

## 3. Safe review actions

Support staff **may**:

- Read reconciliation job results, provider reports, and the audit trail.
- Annotate the incident/ticket with findings, report IDs, and affected transaction references.
- Re-run a **read-only** reconciliation check for the same window (no state mutation).
- Flag specific unmatched transactions for review and assign them to the reconciliation owner.

Support staff **must not**:

- Edit, delete, or re-create ledger entries, balances, or transaction statuses.
- Manually mark transactions as matched/unmatched.
- Issue refunds, reversals, or payouts to "fix" a discrepancy.
- Modify provider reports or reconciliation job configuration.

## 4. Correction approval workflow

Any correction to financial state requires approval:

1. **Prepare evidence:** the provider report ID, the internal record(s) affected, the discrepancy amount, and the proposed correction.
2. **Submit for approval:** attach the evidence to the reconciliation ticket and route it to the reconciliation owner (finance/engineering on-call).
3. **Approval:** the reconciliation owner reviews the evidence and approves or rejects. Corrections above the critical threshold require a second approver.
4. **Apply:** only an authorized operator applies the approved correction, and the action is recorded in the audit trail.
5. **Verify:** re-run reconciliation for the window and confirm the discrepancy is resolved.

No correction is applied without a recorded approval and linked evidence.

## 5. Replay procedure

1. Confirm the original job ID and window from the alert.
2. Verify the provider report for that window is available and current.
3. Trigger a replay of the reconciliation job for the same window (idempotent; does not mutate financial state).
4. Monitor the replay result and compare against the original run.
5. Record the replay outcome in the audit trail. If the discrepancy persists, proceed to the correction approval workflow.

## 6. Escalation ownership

| Situation | Owner |
| --- | --- |
| Unmatched transactions within normal thresholds | Support → reconciliation owner (async review) |
| Critical alert or discrepancy above threshold | Reconciliation owner (finance/engineering on-call) immediately |
| Provider report missing/stale or job failure | Engineering on-call (ingestion/provider integration) |
| Suspected fraud or unauthorized state change | Security on-call, in addition to the reconciliation owner |

Escalate with: alert type, job ID, provider, window, report ID, and a summary of findings. Never resolve a critical alert by manually editing financial state.

## Handsoff notes

<!-- handsoff-issue-882 -->
- #882: Duplicate import of non-existent types crashes the webhook service
