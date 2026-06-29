-- Migration: 20260629_create_webhook_delivery_attempts
-- Description: Per-attempt webhook delivery audit log for queued deliveries

CREATE TABLE webhook_delivery_attempts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_id      UUID NOT NULL REFERENCES merchant_webhooks(id) ON DELETE CASCADE,
    event_type      TEXT NOT NULL,
    payload         JSONB NOT NULL,
    status          VARCHAR(20) NOT NULL
                    CHECK (status IN ('delivered', 'failed')),
    http_status     INTEGER,
    response_body   TEXT,
    error_message   TEXT,
    duration_ms     INTEGER,
    attempt_number  INTEGER NOT NULL,
    job_id          TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_webhook_delivery_attempts_webhook_id
    ON webhook_delivery_attempts (webhook_id, created_at DESC);

CREATE INDEX idx_webhook_delivery_attempts_job_id
    ON webhook_delivery_attempts (job_id);

CREATE INDEX idx_webhook_delivery_attempts_status
    ON webhook_delivery_attempts (webhook_id, status);
