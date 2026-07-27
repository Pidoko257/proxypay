-- Migration: Add trusted devices and two-factor OTP tables
-- Created at: 2026-07-27

CREATE TABLE IF NOT EXISTS trusted_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name VARCHAR(120) NOT NULL,
    user_agent TEXT NOT NULL DEFAULT 'unknown',
    ip_address VARCHAR(45) NOT NULL DEFAULT 'unknown',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trusted_devices_user_id ON trusted_devices(user_id);

CREATE TABLE IF NOT EXISTS two_factor_otps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code VARCHAR(12) NOT NULL,
    channel VARCHAR(20) NOT NULL DEFAULT 'sms',
    verified BOOLEAN DEFAULT false,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_two_factor_otps_user_id ON two_factor_otps(user_id);
