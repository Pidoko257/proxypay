-- Migration: Add user asset preferences for settlement customization
-- Created at: 2026-07-27

CREATE TABLE IF NOT EXISTS user_asset_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset_code VARCHAR(12) NOT NULL,
    issuer_public_key CHAR(56) NOT NULL,
    is_preferred BOOLEAN DEFAULT false,
    is_active_for_settlement BOOLEAN DEFAULT true,
    daily_limit_xaf DECIMAL(20, 2) DEFAULT 500000,
    min_amount_xaf DECIMAL(20, 2) DEFAULT 100,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, asset_code, issuer_public_key)
);

CREATE INDEX IF NOT EXISTS idx_user_asset_preferences_user_id ON user_asset_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_user_asset_preferences_active ON user_asset_preferences(user_id, is_active_for_settlement);

CREATE OR REPLACE FUNCTION update_user_asset_preferences_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_user_asset_preferences_updated_at ON user_asset_preferences;
CREATE TRIGGER update_user_asset_preferences_updated_at
    BEFORE UPDATE ON user_asset_preferences
    FOR EACH ROW
    EXECUTE FUNCTION update_user_asset_preferences_updated_at();
