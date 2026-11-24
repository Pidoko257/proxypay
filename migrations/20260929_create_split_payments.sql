-- Migration: Create split payment tables
-- Created: 2026-09-29

-- Table: split_payment_rules
-- Defines reusable rules for splitting a payment among multiple recipients
CREATE TABLE IF NOT EXISTS split_payment_rules (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(255)  NOT NULL,
  description   TEXT,
  created_by    UUID          REFERENCES users(id) ON DELETE SET NULL,
  is_active     BOOLEAN       NOT NULL DEFAULT true,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Table: split_payment_recipients
-- Defines each recipient within a split payment rule
CREATE TABLE IF NOT EXISTS split_payment_recipients (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id         UUID          NOT NULL REFERENCES split_payment_rules(id) ON DELETE CASCADE,
  recipient_type  VARCHAR(20)   NOT NULL CHECK (recipient_type IN ('user', 'merchant', 'phone')),
  recipient_id    VARCHAR(255)  NOT NULL,
  recipient_label VARCHAR(255),
  split_type      VARCHAR(20)   NOT NULL CHECK (split_type IN ('percentage', 'fixed')),
  split_value     NUMERIC(18,8) NOT NULL,
  priority        INTEGER       NOT NULL DEFAULT 0,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Table: split_payment_ledger
-- Tracks each individual disbursement generated when a split rule is applied to a transaction
CREATE TABLE IF NOT EXISTS split_payment_ledger (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id   UUID          NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  rule_id          UUID          REFERENCES split_payment_rules(id) ON DELETE SET NULL,
  recipient_type   VARCHAR(20)   NOT NULL,
  recipient_id     VARCHAR(255)  NOT NULL,
  recipient_label  VARCHAR(255),
  split_type       VARCHAR(20)   NOT NULL,
  allocated_amount NUMERIC(18,8) NOT NULL,
  currency         VARCHAR(10)   NOT NULL DEFAULT 'XAF',
  status           VARCHAR(20)   NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  processed_at     TIMESTAMP,
  error_message    TEXT,
  metadata         JSONB         DEFAULT '{}',
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_split_payment_recipients_rule_id
  ON split_payment_recipients (rule_id);

CREATE INDEX IF NOT EXISTS idx_split_payment_ledger_rule_id
  ON split_payment_ledger (rule_id);

CREATE INDEX IF NOT EXISTS idx_split_payment_ledger_transaction_id
  ON split_payment_ledger (transaction_id);

CREATE INDEX IF NOT EXISTS idx_split_payment_ledger_status
  ON split_payment_ledger (status);
