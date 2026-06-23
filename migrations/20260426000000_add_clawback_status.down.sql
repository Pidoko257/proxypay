-- Rollback: 20260426000000_add_clawback_status
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_status_check;
ALTER TABLE transactions
  ADD CONSTRAINT transactions_status_check
  CHECK (status IN ('pending', 'completed', 'failed', 'cancelled'));
