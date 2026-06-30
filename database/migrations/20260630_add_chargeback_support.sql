-- Migration: Add chargeback support for mobile money transactions
-- Adds charged_back transaction status, chargeback_reference column, and
-- a chargebacks table for tracking incoming operator chargeback notifications.

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_status_check;
ALTER TABLE transactions
  ADD CONSTRAINT transactions_status_check
  CHECK (status IN (
    'pending', 'completed', 'failed', 'cancelled', 'review',
    'dispute', 'reversed', 'clawed_back', 'charged_back'
  ));

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS chargeback_reference VARCHAR(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS chargeback_reason TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS chargeback_at TIMESTAMP DEFAULT NULL;

CREATE TABLE IF NOT EXISTS chargebacks (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id        UUID         NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  chargeback_reference  VARCHAR(255) NOT NULL,
  reason                TEXT,
  amount                NUMERIC(20,8) NOT NULL,
  currency              VARCHAR(3)   NOT NULL DEFAULT 'USD',
  operator_callback_ref VARCHAR(255),
  metadata              JSONB        DEFAULT '{}',
  processed_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chargebacks_transaction_id ON chargebacks(transaction_id);
CREATE INDEX IF NOT EXISTS idx_chargebacks_reference ON chargebacks(chargeback_reference);
