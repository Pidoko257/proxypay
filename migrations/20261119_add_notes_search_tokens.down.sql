-- Rollback: 20261119_add_notes_search_tokens

DROP INDEX IF EXISTS idx_transactions_admin_notes_search_tokens;
DROP INDEX IF EXISTS idx_transactions_notes_search_tokens;

ALTER TABLE transactions
  DROP COLUMN IF EXISTS admin_notes_search_tokens,
  DROP COLUMN IF EXISTS notes_search_tokens;
