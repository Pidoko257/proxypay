-- Migration: 20260730_create_provider_fee_configs
-- Description: Provider-specific fee configurations with versioning and approval workflow (Issue #200)

-- Provider-specific fee configurations with versioning
CREATE TABLE IF NOT EXISTS provider_fee_configs (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        VARCHAR(20)   NOT NULL,
  fee_percentage  DECIMAL(7,4)  NOT NULL CHECK (fee_percentage >= 0 AND fee_percentage <= 100),
  fee_minimum     DECIMAL(20,7) NOT NULL CHECK (fee_minimum >= 0),
  fee_maximum     DECIMAL(20,7) NOT NULL CHECK (fee_maximum >= fee_minimum),
  is_active       BOOLEAN       NOT NULL DEFAULT false,
  version         INTEGER       NOT NULL DEFAULT 1,
  description     TEXT,
  created_by      UUID          NOT NULL REFERENCES users(id),
  updated_by      UUID          NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  UNIQUE (provider, version)
);

CREATE INDEX IF NOT EXISTS idx_provider_fee_configs_provider        ON provider_fee_configs (provider);
CREATE INDEX IF NOT EXISTS idx_provider_fee_configs_provider_active ON provider_fee_configs (provider, is_active);

-- Fee change approval workflow
CREATE TABLE IF NOT EXISTS fee_change_proposals (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          VARCHAR(20),              -- null = global config change
  fee_config_id     UUID         REFERENCES fee_configurations(id) ON DELETE SET NULL,
  proposed_changes  JSONB        NOT NULL,
  status            VARCHAR(20)  NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  proposed_by       UUID         NOT NULL REFERENCES users(id),
  reviewed_by       UUID         REFERENCES users(id),
  review_note       TEXT,
  proposed_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  reviewed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_fee_proposals_status      ON fee_change_proposals (status);
CREATE INDEX IF NOT EXISTS idx_fee_proposals_proposed_by ON fee_change_proposals (proposed_by);
CREATE INDEX IF NOT EXISTS idx_fee_proposals_proposed_at ON fee_change_proposals (proposed_at DESC);
