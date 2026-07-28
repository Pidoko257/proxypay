CREATE TABLE IF NOT EXISTS sep24_transactions (
  id               UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  kind             VARCHAR(10) NOT NULL CHECK (kind IN ('deposit', 'withdrawal')),
  status           VARCHAR(30) NOT NULL DEFAULT 'pending_user_transfer_start'
                   CHECK (status IN (
                     'pending_user_transfer_start',
                     'pending_external',
                     'pending_anchor',
                     'pending_trust',
                     'pending_stellar',
                     'completed',
                     'failed',
                     'expired'
                   )),
  status_eta       BIGINT,
  amount_in        VARCHAR(30),
  amount_out       VARCHAR(30),
  amount_fee       VARCHAR(30),
  asset_in         VARCHAR(30),
  asset_out        VARCHAR(30),
  account          VARCHAR(56),
  memo             VARCHAR(255),
  memo_type        VARCHAR(10) CHECK (memo_type IN ('text', 'hash', 'id')),
  from_addr        TEXT,
  to_addr          TEXT,
  callback         TEXT,
  message          TEXT,
  more_info_url    TEXT,
  created_at       TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at     TIMESTAMP,
  updated_at       TIMESTAMP   DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sep24_transactions_status ON sep24_transactions (status);
CREATE INDEX IF NOT EXISTS idx_sep24_transactions_kind ON sep24_transactions (kind);
CREATE INDEX IF NOT EXISTS idx_sep24_transactions_account ON sep24_transactions (account);
