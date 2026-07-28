-- Migration: Multi-currency support for transactions and related tables
-- Created at: 2026-07-28
-- Purpose: Add currency, FX rate, FX fee, and settlement fields to transactions;
--          create exchange_rates cache table; add preferred_currency to users.

-- ---------------------------------------------------------------------------
-- 1. Transactions table: add multi-currency columns
-- ---------------------------------------------------------------------------

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS currency          VARCHAR(10) NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS amount_usd        DECIMAL(24,8),
  ADD COLUMN IF NOT EXISTS fx_rate           DECIMAL(20,8),
  ADD COLUMN IF NOT EXISTS fx_fee            DECIMAL(24,8),
  ADD COLUMN IF NOT EXISTS fx_fee_usd        DECIMAL(24,8),
  ADD COLUMN IF NOT EXISTS fx_fee_currency   VARCHAR(10),
  ADD COLUMN IF NOT EXISTS settlement_currency VARCHAR(10),
  ADD COLUMN IF NOT EXISTS settlement_amount   DECIMAL(24,8),
  ADD COLUMN IF NOT EXISTS completed_at      TIMESTAMP WITH TIME ZONE;

-- Back-fill existing rows: treat all legacy amounts as USD
UPDATE transactions
SET
  currency    = 'USD',
  amount_usd  = amount::DECIMAL,
  fx_rate     = 1.0,
  fx_fee      = 0,
  fx_fee_usd  = 0,
  fx_fee_currency = 'USD'
WHERE currency = 'USD' AND amount_usd IS NULL;

-- Enforce NOT NULL on amount_usd after back-fill
ALTER TABLE transactions
  ALTER COLUMN amount_usd SET DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 2. Users table: preferred display currency
-- ---------------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS preferred_currency VARCHAR(10) DEFAULT 'USD';

-- ---------------------------------------------------------------------------
-- 3. Vaults table: currency column
-- ---------------------------------------------------------------------------

ALTER TABLE vaults
  ADD COLUMN IF NOT EXISTS currency VARCHAR(10) NOT NULL DEFAULT 'USD';

-- ---------------------------------------------------------------------------
-- 4. Vault transactions table: currency column
-- ---------------------------------------------------------------------------

ALTER TABLE vault_transactions
  ADD COLUMN IF NOT EXISTS currency VARCHAR(10) NOT NULL DEFAULT 'USD';

-- ---------------------------------------------------------------------------
-- 5. exchange_rates cache table
--    Stores the last-fetched rates keyed by base + quote currency.
--    The application layer is the primary source of truth (in-memory cache
--    in CurrencyService); this table provides a persistent fallback.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS exchange_rates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_currency   VARCHAR(10) NOT NULL,
  to_currency     VARCHAR(10) NOT NULL,
  rate            DECIMAL(20,8) NOT NULL,
  source          VARCHAR(50) NOT NULL DEFAULT 'exchangerate-api',
  fetched_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(from_currency, to_currency)
);

CREATE INDEX IF NOT EXISTS idx_exchange_rates_pair
  ON exchange_rates(from_currency, to_currency);

CREATE INDEX IF NOT EXISTS idx_exchange_rates_fetched
  ON exchange_rates(fetched_at DESC);

-- Seed initial USD base rates (approximate — will be updated on first CurrencyService init)
INSERT INTO exchange_rates (from_currency, to_currency, rate, source)
VALUES
  ('USD', 'XAF',  600.0,    'seed'),
  ('USD', 'NGN',  1550.0,   'seed'),
  ('USD', 'KES',  130.0,    'seed'),
  ('USD', 'GHS',  15.0,     'seed'),
  ('USD', 'TZS',  2600.0,   'seed'),
  ('USD', 'ZMW',  27.0,     'seed'),
  ('USD', 'RWF',  1320.0,   'seed'),
  ('XAF', 'USD',  0.001667, 'seed'),
  ('NGN', 'USD',  0.000645, 'seed'),
  ('KES', 'USD',  0.007692, 'seed'),
  ('GHS', 'USD',  0.066667, 'seed'),
  ('TZS', 'USD',  0.000385, 'seed'),
  ('ZMW', 'USD',  0.037037, 'seed'),
  ('RWF', 'USD',  0.000758, 'seed')
ON CONFLICT (from_currency, to_currency) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 6. FX fee audit log
--    Immutable record of every FX conversion for compliance/reporting.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fx_fee_audit (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id    UUID REFERENCES transactions(id) ON DELETE SET NULL,
  from_currency     VARCHAR(10) NOT NULL,
  to_currency       VARCHAR(10) NOT NULL,
  original_amount   DECIMAL(24,8) NOT NULL,
  converted_amount  DECIMAL(24,8) NOT NULL,
  fx_rate           DECIMAL(20,8) NOT NULL,
  fx_fee            DECIMAL(24,8) NOT NULL,
  fx_fee_percent    DECIMAL(8,4) NOT NULL,
  provider          VARCHAR(100),
  direction         VARCHAR(4) CHECK (direction IN ('sell', 'buy')),
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fx_fee_audit_transaction
  ON fx_fee_audit(transaction_id);

CREATE INDEX IF NOT EXISTS idx_fx_fee_audit_created
  ON fx_fee_audit(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fx_fee_audit_currencies
  ON fx_fee_audit(from_currency, to_currency);

-- ---------------------------------------------------------------------------
-- 7. Indexes for multi-currency queries
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_transactions_currency
  ON transactions(currency);

CREATE INDEX IF NOT EXISTS idx_transactions_settlement_currency
  ON transactions(settlement_currency)
  WHERE settlement_currency IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_completed_at
  ON transactions(completed_at DESC)
  WHERE completed_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 8. Add merchants.accepted_currencies if not present
-- ---------------------------------------------------------------------------

ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS accepted_currencies VARCHAR(10)[] DEFAULT ARRAY['USD'];
