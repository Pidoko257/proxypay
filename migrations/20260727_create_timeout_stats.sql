-- Migration: 20260727_create_timeout_stats
-- Creates tables for timeout statistics tracking and partial-recovery logging.

-- ---------------------------------------------------------------------------
-- timeout_stats
-- Stores every hard-timeout event recorded by the TimeoutService.
-- Indexed for efficient time-window queries and per-operation-type aggregation.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS timeout_stats (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_type   VARCHAR(64)  NOT NULL,
  request_path     VARCHAR(512) NOT NULL,
  http_method      VARCHAR(10)  NOT NULL,
  elapsed_ms       INTEGER      NOT NULL,
  request_id       VARCHAR(128),
  transaction_id   UUID,
  occurred_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Fast time-window scans (most common query pattern)
CREATE INDEX IF NOT EXISTS idx_timeout_stats_occurred_at
  ON timeout_stats (occurred_at DESC);

-- Per-operation-type aggregation
CREATE INDEX IF NOT EXISTS idx_timeout_stats_operation_type
  ON timeout_stats (operation_type, occurred_at DESC);

-- Transaction-level lookup (recovery joins)
CREATE INDEX IF NOT EXISTS idx_timeout_stats_transaction_id
  ON timeout_stats (transaction_id)
  WHERE transaction_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- timeout_recovery_log
-- Records every partial-recovery attempt made after a timeout.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS timeout_recovery_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_type   VARCHAR(64)  NOT NULL,
  transaction_id   UUID,
  reference_id     VARCHAR(255),
  provider         VARCHAR(64),
  stellar_tx_hash  VARCHAR(128),
  elapsed_ms       INTEGER      NOT NULL,
  recovery_status  VARCHAR(32)  NOT NULL,  -- CONFIRMED | NOT_FOUND | RECOVERY_ERROR | NOT_APPLICABLE | PENDING
  message          TEXT,
  occurred_at      TIMESTAMP WITH TIME ZONE NOT NULL,
  recovered_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Fast per-transaction lookup
CREATE INDEX IF NOT EXISTS idx_timeout_recovery_transaction_id
  ON timeout_recovery_log (transaction_id)
  WHERE transaction_id IS NOT NULL;

-- Time-window queries for the dashboard
CREATE INDEX IF NOT EXISTS idx_timeout_recovery_recovered_at
  ON timeout_recovery_log (recovered_at DESC);

-- Filter by recovery outcome
CREATE INDEX IF NOT EXISTS idx_timeout_recovery_status
  ON timeout_recovery_log (recovery_status, recovered_at DESC);
