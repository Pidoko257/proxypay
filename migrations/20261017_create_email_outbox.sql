-- Migration: 20261017_create_email_outbox
-- Description: Create email outbox table for reliable, deduplicat email delivery
--              with transient failure handling, bounded retries, and provider
--              response tracking.

CREATE TABLE email_outbox (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_email VARCHAR(255) NOT NULL,
    
    -- Email type: transaction_receipt, kyc_status, account_security, invoice, etc.
    -- Enables type-specific logic and troubleshooting
    email_type      VARCHAR(50) NOT NULL,
    
    -- Deduplication key: hash(email_type + recipient + context)
    -- Allows idempotent operations (e.g., retry API calls don't send duplicate receipts)
    dedup_key       VARCHAR(255),
    
    -- Subject and body (rendered at queue time, not send time)
    subject         TEXT NOT NULL,
    body_html       TEXT,
    body_text       TEXT,
    
    -- Provider response data
    provider_name   VARCHAR(50), -- sendgrid, nodemailer, aws_ses, etc.
    provider_id     VARCHAR(255), -- MessageID from SendGrid / SES, etc.
    provider_response JSONB, -- Full response from provider (headers, status, etc.)
    
    -- Status: pending, processing, delivered, failed, dlq
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'dlq')),
    
    -- Bounded retries
    attempts        INTEGER DEFAULT 0,
    max_attempts    INTEGER DEFAULT 5,
    
    -- Retry timing
    last_attempt_at TIMESTAMP,
    next_attempt_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Error tracking
    error_message   TEXT,
    error_code      VARCHAR(50),
    
    -- Context for troubleshooting and monitoring
    related_entity_type VARCHAR(50), -- transaction, kyc, invoice, etc.
    related_entity_id   VARCHAR(255), -- transaction_id, user_id, invoice_id, etc.
    user_id         UUID,
    
    -- Headers (From, Reply-To, etc.) as JSON
    headers         JSONB,
    
    -- Attachments metadata (not stored as files, just references)
    attachments_metadata JSONB,
    
    -- Audit trail
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    delivered_at    TIMESTAMP
);

-- Indexes for efficient outbox worker scans
CREATE INDEX idx_email_outbox_status_next_retry
  ON email_outbox (status, next_attempt_at)
  WHERE status IN ('pending', 'failed');

-- Index for deduplication checks
CREATE INDEX idx_email_outbox_dedup_key
  ON email_outbox (dedup_key)
  WHERE dedup_key IS NOT NULL AND status IN ('pending', 'delivered', 'processing');

-- Index for bulk operations by email type
CREATE INDEX idx_email_outbox_type_status
  ON email_outbox (email_type, status)
  WHERE status IN ('pending', 'failed');

-- Index for user email history and monitoring
CREATE INDEX idx_email_outbox_user_id_created
  ON email_outbox (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

-- Index for entity tracking (e.g., all emails related to a transaction)
CREATE INDEX idx_email_outbox_related_entity
  ON email_outbox (related_entity_type, related_entity_id, created_at DESC)
  WHERE related_entity_type IS NOT NULL;

-- Index for admin visibility and filtering
CREATE INDEX idx_email_outbox_status_created
  ON email_outbox (status, created_at DESC);
