-- Migration: 20260626_create_fee_engine_configs
-- Three configurable components of the fee engine:
--   1. ProxyPay tier fee  (org_tier  -> percentage)
--   2. Operator flat fee  (provider + country -> flat amount in local currency)
--   3. Stellar network fee is read from env/constant; no DB row needed.

-- ── ProxyPay tier fee ─────────────────────────────────────────────────────────
-- org_tier values mirror the organisation KYC/pricing tier (e.g. 'standard',
-- 'premium', 'enterprise').  fee_percentage is stored as a plain number
-- (e.g. 1.5 means 1.5%).

CREATE TABLE IF NOT EXISTS fee_engine_tier_configs (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  org_tier       VARCHAR(50)   NOT NULL,
  fee_percentage DECIMAL(6,4)  NOT NULL CHECK (fee_percentage >= 0 AND fee_percentage <= 100),
  fee_minimum    DECIMAL(20,7) NOT NULL DEFAULT 0 CHECK (fee_minimum >= 0),
  fee_maximum    DECIMAL(20,7) NOT NULL DEFAULT 999999999 CHECK (fee_maximum >= fee_minimum),
  is_active      BOOLEAN       NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (org_tier)
);

CREATE INDEX IF NOT EXISTS idx_fee_engine_tier_active ON fee_engine_tier_configs (org_tier) WHERE is_active = true;

-- ── Operator flat fee ─────────────────────────────────────────────────────────
-- provider: 'mtn' | 'airtel' | 'orange' (lowercase)
-- country_code: ISO 3166-1 alpha-2 (e.g. 'CM', 'KE')
-- flat_amount: charged in the transaction's local currency

CREATE TABLE IF NOT EXISTS fee_engine_operator_configs (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     VARCHAR(50)   NOT NULL,
  country_code CHAR(2)       NOT NULL,
  flat_amount  DECIMAL(20,7) NOT NULL CHECK (flat_amount >= 0),
  is_active    BOOLEAN       NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (provider, country_code)
);

CREATE INDEX IF NOT EXISTS idx_fee_engine_operator_active
  ON fee_engine_operator_configs (provider, country_code) WHERE is_active = true;

-- ── Triggers: keep updated_at current ────────────────────────────────────────
CREATE OR REPLACE FUNCTION _fee_engine_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_fee_engine_tier_updated_at   ON fee_engine_tier_configs;
CREATE TRIGGER trg_fee_engine_tier_updated_at
  BEFORE UPDATE ON fee_engine_tier_configs
  FOR EACH ROW EXECUTE FUNCTION _fee_engine_set_updated_at();

DROP TRIGGER IF EXISTS trg_fee_engine_operator_updated_at ON fee_engine_operator_configs;
CREATE TRIGGER trg_fee_engine_operator_updated_at
  BEFORE UPDATE ON fee_engine_operator_configs
  FOR EACH ROW EXECUTE FUNCTION _fee_engine_set_updated_at();

-- ── Seed defaults ─────────────────────────────────────────────────────────────
INSERT INTO fee_engine_tier_configs (org_tier, fee_percentage, fee_minimum, fee_maximum) VALUES
  ('standard',   1.50, 50,   5000),
  ('premium',    1.00, 25,   5000),
  ('enterprise', 0.50,  0,   5000)
ON CONFLICT (org_tier) DO NOTHING;

INSERT INTO fee_engine_operator_configs (provider, country_code, flat_amount) VALUES
  ('mtn',    'CM', 100),
  ('mtn',    'GH', 0.5),
  ('mtn',    'UG', 500),
  ('airtel', 'KE', 10),
  ('airtel', 'TZ', 200),
  ('orange', 'CM', 100),
  ('orange', 'SN', 75)
ON CONFLICT (provider, country_code) DO NOTHING;
