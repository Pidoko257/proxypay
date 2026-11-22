-- Migration: 20261119_create_transaction_status_history
-- Description: Durable store for detailed transaction status transitions.
-- Replaces the per-process in-memory history map in
-- TransactionStatusWorkflowService so history survives pod restarts and is
-- visible to every API replica.

CREATE TABLE IF NOT EXISTS transaction_status_history (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  VARCHAR(255) NOT NULL,
  from_status     VARCHAR(64),
  to_status       VARCHAR(64)  NOT NULL,
  reason          TEXT,
  explanation     TEXT         NOT NULL,
  updated_by      VARCHAR(255) NOT NULL DEFAULT 'system',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transaction_status_history_tx_created
  ON transaction_status_history (transaction_id, created_at, id);
