-- Migration: Cryptographic Request Signing Infrastructure
-- Description: Secure API key management, signature tracking, and audit logging for provider requests

-- Table: Provider API Keys (Secure Storage)
CREATE TABLE IF NOT EXISTS provider_api_keys (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_name         VARCHAR(50) NOT NULL,  -- MTN, Airtel, Orange
  key_type              VARCHAR(20) NOT NULL,  -- hmac_secret, rsa_private, api_key
  
  -- Key material (encrypted at rest)
  key_material          BYTEA       NOT NULL,  -- Encrypted with master key
  key_hash              VARCHAR(64),           -- SHA256 hash for lookups (not sensitive)
  
  -- Key metadata
  version               INT         NOT NULL DEFAULT 1,
  is_active             BOOLEAN     DEFAULT TRUE,
  
  -- Rotation tracking
  created_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activated_at          TIMESTAMP,
  deactivated_at        TIMESTAMP,
  rotated_from_id       UUID REFERENCES provider_api_keys(id),
  
  -- Key properties
  algorithm             VARCHAR(50),  -- HMAC-SHA256, RSA-SHA256, etc.
  key_expiry            TIMESTAMP,
  
  created_by            VARCHAR(100),
  rotated_by            VARCHAR(100),
  
  UNIQUE(provider_name, version)
);

CREATE INDEX IF NOT EXISTS idx_api_keys_provider ON provider_api_keys(provider_name);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON provider_api_keys(is_active, provider_name);
CREATE INDEX IF NOT EXISTS idx_api_keys_version ON provider_api_keys(provider_name, version DESC);

-- Table: Signature Audit Log
-- Immutable log of all signed requests for compliance and security
CREATE TABLE IF NOT EXISTS signature_audit_logs (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Request identification
  request_id            VARCHAR(100) UNIQUE,
  provider_name         VARCHAR(50) NOT NULL,
  endpoint              VARCHAR(255) NOT NULL,
  http_method           VARCHAR(10) NOT NULL,
  
  -- Signature details
  signature_algorithm   VARCHAR(50) NOT NULL,  -- HMAC-SHA256, RSA-SHA256
  signature_version     INT         NOT NULL DEFAULT 1,
  api_key_version       INT         NOT NULL,
  
  -- Request details (for audit)
  request_timestamp     TIMESTAMP   NOT NULL,
  nonce                 VARCHAR(100),
  
  -- Signature verification
  signature_provided    VARCHAR(512),
  signature_valid       BOOLEAN     NOT NULL,
  verification_time_ms  INT,
  
  -- Status tracking
  request_status        VARCHAR(20),  -- pending, sent, failed, completed
  response_code         INT,
  
  -- IP and source tracking
  source_ip             INET,
  source_service        VARCHAR(100),
  
  -- Audit metadata
  created_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  -- User tracking (if applicable)
  user_id               UUID,
  transaction_id        UUID
);

CREATE INDEX IF NOT EXISTS idx_audit_provider ON signature_audit_logs(provider_name);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON signature_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_request_id ON signature_audit_logs(request_id);
CREATE INDEX IF NOT EXISTS idx_audit_valid ON signature_audit_logs(signature_valid);
CREATE INDEX IF NOT EXISTS idx_audit_transaction ON signature_audit_logs(transaction_id);

-- Table: Webhook Signatures
-- Track webhook signatures for callback verification
CREATE TABLE IF NOT EXISTS webhook_signatures (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Webhook identification
  webhook_id            VARCHAR(100) UNIQUE,
  provider_name         VARCHAR(50) NOT NULL,
  webhook_type          VARCHAR(50),  -- payment_confirmation, transaction_status, etc.
  
  -- Signature details
  signature_provided    VARCHAR(512) NOT NULL,
  signature_algorithm   VARCHAR(50) NOT NULL,
  api_key_version       INT         NOT NULL,
  
  -- Webhook payload details
  payload_hash          VARCHAR(64),
  timestamp_header      VARCHAR(50),
  nonce_header          VARCHAR(100),
  
  -- Verification results
  signature_valid       BOOLEAN     NOT NULL,
  verified_at           TIMESTAMP,
  replay_check_passed   BOOLEAN,
  
  -- Source tracking
  source_ip             INET,
  user_agent            TEXT,
  
  -- Payload reference
  transaction_id        UUID        REFERENCES transactions(id) ON DELETE SET NULL,
  
  created_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_webhooks_provider ON webhook_signatures(provider_name);
CREATE INDEX IF NOT EXISTS idx_webhooks_valid ON webhook_signatures(signature_valid);
CREATE INDEX IF NOT EXISTS idx_webhooks_timestamp ON webhook_signatures(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhooks_webhook_id ON webhook_signatures(webhook_id);

-- Table: Key Rotation History
-- Track all key rotation events for compliance and audit
CREATE TABLE IF NOT EXISTS key_rotation_history (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  
  provider_name         VARCHAR(50) NOT NULL,
  old_key_id            UUID        REFERENCES provider_api_keys(id),
  new_key_id            UUID        REFERENCES provider_api_keys(id),
  
  -- Rotation details
  rotation_reason       VARCHAR(100),  -- scheduled, emergency, manual, expiration
  rotation_type         VARCHAR(50),   -- active_rotation, staged_rotation, immediate
  
  -- Timeline
  initiated_at          TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activation_at         TIMESTAMP,
  completion_at         TIMESTAMP,
  
  -- Responsibility
  initiated_by          VARCHAR(100),
  completed_by          VARCHAR(100),
  
  -- Status
  status                VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending, in_progress, completed, failed
  error_message         TEXT,
  
  -- Metrics
  requests_with_old_key INT DEFAULT 0,
  requests_with_new_key INT DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_rotation_provider ON key_rotation_history(provider_name);
CREATE INDEX IF NOT EXISTS idx_rotation_status ON key_rotation_history(status);
CREATE INDEX IF NOT EXISTS idx_rotation_initiated ON key_rotation_history(initiated_at DESC);

-- Table: Signature Failures (Security Monitoring)
-- Track failed signature verifications for security alerting
CREATE TABLE IF NOT EXISTS signature_failures (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  
  provider_name         VARCHAR(50) NOT NULL,
  endpoint              VARCHAR(255) NOT NULL,
  
  -- Failure details
  failure_reason        VARCHAR(100) NOT NULL,  -- invalid_signature, expired_key, replay_attack, timestamp_invalid, etc.
  failure_type          VARCHAR(30),  -- verification_failure, key_error, algorithm_error
  
  -- Request details
  source_ip             INET,
  request_timestamp     TIMESTAMP,
  nonce                 VARCHAR(100),
  
  -- Response
  response_code         INT,
  error_message         TEXT,
  
  -- Severity and handling
  severity              VARCHAR(10),  -- low, medium, high, critical
  requires_investigation BOOLEAN DEFAULT FALSE,
  
  created_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_failures_provider ON signature_failures(provider_name);
CREATE INDEX IF NOT EXISTS idx_failures_reason ON signature_failures(failure_reason);
CREATE INDEX IF NOT EXISTS idx_failures_timestamp ON signature_failures(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_failures_severity ON signature_failures(severity);

-- Table: Nonce Cache (Replay Attack Prevention)
-- Fast lookup for nonce replay detection
CREATE TABLE IF NOT EXISTS nonce_cache (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  
  nonce                 VARCHAR(100) UNIQUE NOT NULL,
  provider_name         VARCHAR(50) NOT NULL,
  
  -- Usage tracking
  used_at               TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at            TIMESTAMP   NOT NULL,
  
  request_id            VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_nonce_provider_time ON nonce_cache(provider_name, used_at DESC);
CREATE INDEX IF NOT EXISTS idx_nonce_expires ON nonce_cache(expires_at);

-- Trigger for audit log immutability (prevent deletion)
CREATE OR REPLACE FUNCTION prevent_audit_deletion()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit logs cannot be deleted - immutability enforced';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_immutable ON signature_audit_logs;
CREATE TRIGGER audit_immutable
  BEFORE DELETE ON signature_audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_deletion();

-- Down migration
-- DROP TRIGGER IF EXISTS audit_immutable ON signature_audit_logs;
-- DROP FUNCTION IF EXISTS prevent_audit_deletion();
-- DROP TABLE IF EXISTS nonce_cache;
-- DROP TABLE IF EXISTS signature_failures;
-- DROP TABLE IF EXISTS key_rotation_history;
-- DROP TABLE IF EXISTS webhook_signatures;
-- DROP TABLE IF EXISTS signature_audit_logs;
-- DROP TABLE IF EXISTS provider_api_keys;
