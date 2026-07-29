-- Migration: Wallet Balance Reconciliation Infrastructure
-- Description: Create tables for wallet balance reconciliation, discrepancy tracking, and historical records
-- Up migration

-- Table: Reconciliation Jobs
-- Tracks reconciliation job runs with status and metrics
CREATE TABLE IF NOT EXISTS reconciliation_jobs (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type              VARCHAR(50) NOT NULL,  -- 'stellar_ledger', 'vault', 'user_wallet', etc.
  status                VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending, in_progress, completed, failed, partial
  started_at            TIMESTAMP,
  completed_at          TIMESTAMP,
  
  -- Reconciliation statistics
  total_accounts        INT         NOT NULL DEFAULT 0,
  successful_checks     INT         NOT NULL DEFAULT 0,
  discrepancies_found   INT         NOT NULL DEFAULT 0,
  auto_corrections      INT         NOT NULL DEFAULT 0,
  manual_reviews_needed INT         NOT NULL DEFAULT 0,
  
  -- Duration and performance
  duration_ms           INT,
  errors_encountered    INT         DEFAULT 0,
  
  -- Logging
  error_message         TEXT,
  summary               TEXT,
  
  created_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_jobs_status ON reconciliation_jobs(status);
CREATE INDEX IF NOT EXISTS idx_reconciliation_jobs_created_at ON reconciliation_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reconciliation_jobs_job_type ON reconciliation_jobs(job_type);

-- Table: Discrepancy Log
-- Detailed record of every discrepancy detected
CREATE TABLE IF NOT EXISTS wallet_discrepancies (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_job_id UUID        NOT NULL REFERENCES reconciliation_jobs(id) ON DELETE CASCADE,
  
  -- Entity identification
  user_id               UUID        REFERENCES users(id) ON DELETE CASCADE,
  vault_id              UUID,
  wallet_address        VARCHAR(56),
  account_identifier    VARCHAR(100),  -- Generic account ID for various types
  
  -- Balance comparison
  ledger_balance        DECIMAL(20, 7),
  stellar_balance       DECIMAL(20, 7),
  discrepancy_amount    DECIMAL(20, 7) NOT NULL,
  discrepancy_type      VARCHAR(20) NOT NULL,  -- 'ledger_surplus', 'ledger_deficit', 'stellar_surplus', 'stellar_deficit'
  
  -- Asset details
  asset_code            VARCHAR(12),
  issuer_address        VARCHAR(56),
  
  -- Investigation
  status                VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending, investigating, auto_corrected, manual_review, resolved
  resolution_type       VARCHAR(30),  -- 'auto_corrected', 'manual_adjustment', 'blockchain_confirmed', 'ledger_reversal', etc.
  
  -- Investigation details
  possible_causes       TEXT[],    -- Array of potential causes
  investigation_notes   TEXT,
  resolution_notes      TEXT,
  
  -- Automatic correction
  auto_correction_applied BOOLEAN DEFAULT FALSE,
  correction_transaction_id UUID,
  
  -- Manual review
  reviewed_by           UUID,      -- Admin user who reviewed
  reviewed_at           TIMESTAMP,
  manual_resolution_at  TIMESTAMP,
  
  severity              VARCHAR(10),  -- 'critical', 'high', 'medium', 'low'
  
  created_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at           TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_discrepancies_user_id ON wallet_discrepancies(user_id);
CREATE INDEX IF NOT EXISTS idx_discrepancies_status ON wallet_discrepancies(status);
CREATE INDEX IF NOT EXISTS idx_discrepancies_job_id ON wallet_discrepancies(reconciliation_job_id);
CREATE INDEX IF NOT EXISTS idx_discrepancies_severity ON wallet_discrepancies(severity);
CREATE INDEX IF NOT EXISTS idx_discrepancies_created_at ON wallet_discrepancies(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_discrepancies_wallet_address ON wallet_discrepancies(wallet_address);
CREATE INDEX IF NOT EXISTS idx_discrepancies_resolved ON wallet_discrepancies(status, resolved_at DESC);

-- Table: Account Snapshots
-- Periodic snapshots of account balances for audit trail
CREATE TABLE IF NOT EXISTS account_balance_snapshots (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_job_id UUID        NOT NULL REFERENCES reconciliation_jobs(id) ON DELETE CASCADE,
  
  -- Account identification
  user_id               UUID        REFERENCES users(id) ON DELETE CASCADE,
  vault_id              UUID,
  wallet_address        VARCHAR(56),
  account_type          VARCHAR(30),  -- 'stellar', 'vault', 'user_main', etc.
  
  -- Balance snapshot
  ledger_balance        DECIMAL(20, 7),
  stellar_balance       DECIMAL(20, 7),
  vault_balance         DECIMAL(20, 7),
  
  -- Asset info
  asset_code            VARCHAR(12),
  issuer_address        VARCHAR(56),
  
  -- Transaction activity
  recent_transaction_count INT,
  last_transaction_at   TIMESTAMP,
  
  -- Quality metrics
  balance_consistency   BOOLEAN,    -- Whether balance is consistent
  reconciliation_status VARCHAR(20),  -- 'success', 'discrepancy', 'error'
  
  created_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_snapshots_user_id ON account_balance_snapshots(user_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_job_id ON account_balance_snapshots(reconciliation_job_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_created_at ON account_balance_snapshots(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_status ON account_balance_snapshots(reconciliation_status);

-- Table: Stellar Transaction Verification
-- Tracks Stellar transactions that need verification
CREATE TABLE IF NOT EXISTS stellar_transaction_verifications (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  stellar_tx_hash       VARCHAR(64) UNIQUE,
  
  -- Transaction details
  source_account        VARCHAR(56),
  destination_account   VARCHAR(56),
  operation_type        VARCHAR(50),  -- 'payment', 'path_payment', 'create_account', etc.
  amount                DECIMAL(20, 7),
  
  -- ProxyPay reference
  proxypay_transaction_id UUID,
  user_id               UUID        REFERENCES users(id) ON DELETE SET NULL,
  
  -- Verification status
  status                VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending, verified, failed, discrepancy
  verified_at           TIMESTAMP,
  
  -- Ledger confirmation
  ledger_num            BIGINT,     -- Stellar ledger number
  confirmed             BOOLEAN     DEFAULT FALSE,
  final_confirmations   INT         DEFAULT 0,
  
  -- Discrepancy tracking
  discrepancy_found     BOOLEAN     DEFAULT FALSE,
  discrepancy_type      VARCHAR(50),
  
  created_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stellar_tx_hash ON stellar_transaction_verifications(stellar_tx_hash);
CREATE INDEX IF NOT EXISTS idx_stellar_tx_status ON stellar_transaction_verifications(status);
CREATE INDEX IF NOT EXISTS idx_stellar_tx_user_id ON stellar_transaction_verifications(user_id);
CREATE INDEX IF NOT EXISTS idx_stellar_tx_created_at ON stellar_transaction_verifications(created_at DESC);

-- Table: Reconciliation Settings
-- Configuration for reconciliation behavior and thresholds
CREATE TABLE IF NOT EXISTS reconciliation_settings (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Thresholds for discrepancy detection
  discrepancy_threshold_usd DECIMAL(10, 2) DEFAULT 1.00,  -- Minimum discrepancy to report
  critical_threshold_usd    DECIMAL(10, 2) DEFAULT 1000.00,  -- Critical alert threshold
  
  -- Auto-correction settings
  auto_correct_enabled      BOOLEAN DEFAULT FALSE,
  auto_correct_max_amount   DECIMAL(20, 7) DEFAULT 0,  -- 0 = disabled
  auto_correct_ledger_only  BOOLEAN DEFAULT TRUE,  -- Only auto-correct ledger, not blockchain
  
  -- Reconciliation frequency
  reconciliation_interval_minutes INT DEFAULT 60,
  
  -- Alert settings
  alert_enabled             BOOLEAN DEFAULT TRUE,
  alert_channels            VARCHAR(50)[],  -- 'email', 'slack', 'pagerduty', etc.
  alert_recipients          TEXT[],
  
  -- Investigation settings
  max_auto_investigation_days INT DEFAULT 30,
  enable_manual_override      BOOLEAN DEFAULT TRUE,
  
  -- Performance
  batch_size                INT DEFAULT 100,
  max_parallel_checks       INT DEFAULT 10,
  
  created_at                TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Table: Reconciliation History (for trending)
CREATE TABLE IF NOT EXISTS reconciliation_history (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  
  job_date              DATE        NOT NULL,
  job_type              VARCHAR(50) NOT NULL,
  
  -- Aggregated metrics
  total_accounts_checked INT,
  discrepancies_found    INT,
  auto_corrections       INT,
  manual_reviews         INT,
  
  -- Health metrics
  success_rate           DECIMAL(5, 2),
  avg_discrepancy_amount DECIMAL(20, 7),
  
  -- Timing
  avg_duration_ms        INT,
  
  created_at             TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_recon_history_job_date ON reconciliation_history(job_date DESC);
CREATE INDEX IF NOT EXISTS idx_recon_history_job_type ON reconciliation_history(job_type);

-- Trigger: Update reconciliation_jobs updated_at
CREATE OR REPLACE FUNCTION update_reconciliation_jobs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reconciliation_jobs_updated_at ON reconciliation_jobs;
CREATE TRIGGER reconciliation_jobs_updated_at
  BEFORE UPDATE ON reconciliation_jobs
  FOR EACH ROW EXECUTE FUNCTION update_reconciliation_jobs_updated_at();

-- Trigger: Update wallet_discrepancies updated_at
CREATE OR REPLACE FUNCTION update_wallet_discrepancies_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wallet_discrepancies_updated_at ON wallet_discrepancies;
CREATE TRIGGER wallet_discrepancies_updated_at
  BEFORE UPDATE ON wallet_discrepancies
  FOR EACH ROW EXECUTE FUNCTION update_wallet_discrepancies_updated_at();

-- Trigger: Update stellar_transaction_verifications updated_at
CREATE OR REPLACE FUNCTION update_stellar_tx_verifications_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS stellar_tx_verifications_updated_at ON stellar_transaction_verifications;
CREATE TRIGGER stellar_tx_verifications_updated_at
  BEFORE UPDATE ON stellar_transaction_verifications
  FOR EACH ROW EXECUTE FUNCTION update_stellar_tx_verifications_updated_at();

-- Trigger: Update reconciliation_settings updated_at
CREATE OR REPLACE FUNCTION update_reconciliation_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reconciliation_settings_updated_at ON reconciliation_settings;
CREATE TRIGGER reconciliation_settings_updated_at
  BEFORE UPDATE ON reconciliation_settings
  FOR EACH ROW EXECUTE FUNCTION update_reconciliation_settings_updated_at();

-- Insert default reconciliation settings
INSERT INTO reconciliation_settings (
  id,
  discrepancy_threshold_usd,
  critical_threshold_usd,
  auto_correct_enabled,
  reconciliation_interval_minutes,
  alert_enabled
) VALUES (
  gen_random_uuid(),
  1.00,
  1000.00,
  FALSE,
  60,
  TRUE
) ON CONFLICT DO NOTHING;

-- Down migration
-- DROP TRIGGER IF EXISTS reconciliation_settings_updated_at ON reconciliation_settings;
-- DROP TRIGGER IF EXISTS stellar_tx_verifications_updated_at ON stellar_transaction_verifications;
-- DROP TRIGGER IF EXISTS wallet_discrepancies_updated_at ON wallet_discrepancies;
-- DROP TRIGGER IF EXISTS reconciliation_jobs_updated_at ON reconciliation_jobs;
-- DROP FUNCTION IF EXISTS update_reconciliation_settings_updated_at();
-- DROP FUNCTION IF EXISTS update_stellar_tx_verifications_updated_at();
-- DROP FUNCTION IF EXISTS update_wallet_discrepancies_updated_at();
-- DROP FUNCTION IF EXISTS update_reconciliation_jobs_updated_at();
-- DROP TABLE IF EXISTS reconciliation_history;
-- DROP TABLE IF EXISTS reconciliation_settings;
-- DROP TABLE IF EXISTS stellar_transaction_verifications;
-- DROP TABLE IF EXISTS account_balance_snapshots;
-- DROP TABLE IF EXISTS wallet_discrepancies;
-- DROP TABLE IF EXISTS reconciliation_jobs;
