-- Migration: 20260630_create_request_logs_table
-- Description: Create request_logs table to track all API requests for analytics, debugging, and compliance

CREATE TABLE IF NOT EXISTS request_logs (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id      UUID        NOT NULL,
    method          VARCHAR(10) NOT NULL,
    path            TEXT        NOT NULL,
    status_code     INTEGER     NOT NULL,
    duration_ms     INTEGER     NOT NULL,
    api_key_id      UUID,
    user_id         UUID,
    ip_address      INET,
    user_agent      TEXT,
    created_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_request_logs_request_id ON request_logs(request_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_user_id ON request_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_api_key_id ON request_logs(api_key_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_status_code ON request_logs(status_code);
