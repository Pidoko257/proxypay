-- Migration: 20260624_create_provider_onboarding_tables
-- Description: Provider Onboarding Workflow tables for issue #187.
-- Adds encrypted credential storage (AES-256-GCM payloads keyed by version)
-- and a DB-backed provider health check configuration that augments the
-- static DEFAULT_PROVIDERS array in src/services/mobilemoney/providers/healthCheck.ts.

-- ---------------------------------------------------------------------------
-- Encrypted provider credentials
-- Stores auth-mode and an encrypted JSON payload containing API keys,
-- secrets, subscription keys, OAuth client ids, etc. The payload is
-- encrypted at the application layer using src/utils/encryption.ts and
-- stored as a single TEXT column in '<version>:<iv>:<authTag>:<ciphertext>'
-- format. Master key material lives in DB_ENCRYPTION_KEY (AES-256-GCM).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_credentials (
  provider_name      VARCHAR(64)  PRIMARY KEY,
  auth_mode          VARCHAR(32)  NOT NULL DEFAULT 'direct',
  encrypted_payload  TEXT         NOT NULL,
  last_rotated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT provider_credentials_auth_mode_check
    CHECK (auth_mode IN ('direct', 'web', 'proxy', 'api_key', 'oauth'))
);

CREATE INDEX IF NOT EXISTS idx_provider_credentials_updated_at
  ON provider_credentials (updated_at DESC);

-- ---------------------------------------------------------------------------
-- DB-backed provider health check configurations
-- Augments the in-code DEFAULT_PROVIDERS list. The runtime health check
-- unions both sources into a single ping list. Disabling a row stops the
-- provider from being pinged without redeploying the service.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_health_configs (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_name   VARCHAR(64)  NOT NULL UNIQUE,
  ping_url        TEXT         NOT NULL,
  timeout_ms      INTEGER      NOT NULL DEFAULT 5000,
  enabled         BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT provider_health_configs_timeout_check
    CHECK (timeout_ms > 0 AND timeout_ms <= 60000)
);

CREATE INDEX IF NOT EXISTS idx_provider_health_configs_enabled
  ON provider_health_configs (enabled)
  WHERE enabled = TRUE;

CREATE INDEX IF NOT EXISTS idx_provider_health_configs_provider_name
  ON provider_health_configs (provider_name);

-- ---------------------------------------------------------------------------
-- Onboarding checklist state (per provider)
-- Lets the provider-onboard CLI track progress across runs and lets
-- the operations team surface the status via the dashboard / API.
-- One row per provider with a JSONB state blob holding per-step results.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_onboarding_state (
  provider_name     VARCHAR(64)  PRIMARY KEY,
  status            VARCHAR(32)  NOT NULL DEFAULT 'in_progress',
  steps             JSONB        NOT NULL DEFAULT '{}'::jsonb,
  notes             TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT provider_onboarding_state_status_check
    CHECK (status IN ('in_progress', 'ready', 'live', 'deprecated', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_provider_onboarding_state_status
  ON provider_onboarding_state (status);
