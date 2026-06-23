-- Rollback: 20260421000000_add_provider_reference_to_transactions
ALTER TABLE transactions DROP COLUMN IF EXISTS provider_reference;
