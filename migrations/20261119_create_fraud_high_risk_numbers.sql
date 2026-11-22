-- Migration: 20261119_create_fraud_high_risk_numbers
-- Description: Source of truth for the high-risk phone number list used by the
--              fraud detection service (heuristic #5). Redis caches the active
--              set; this table is read on cache miss.

CREATE TABLE IF NOT EXISTS fraud_high_risk_numbers (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number  VARCHAR(32) NOT NULL UNIQUE,
    reason        TEXT,
    source        VARCHAR(100),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fraud_high_risk_numbers_active
    ON fraud_high_risk_numbers (phone_number)
    WHERE is_active = TRUE;
