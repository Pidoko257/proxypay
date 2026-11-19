-- Migration: 20261119_add_notes_search_tokens
-- Description: notes / admin_notes are encrypted at rest, so running
--              to_tsvector() over them indexes ciphertext and never matches.
--              Store keyed (HMAC) digests of the normalized words instead, so
--              notes search can use an indexed predicate without exposing
--              plaintext to the database (same approach as phone_search_tokens).
--
-- Existing rows start with empty token arrays; populate them with
--   npx ts-node scripts/backfill-notes-search-tokens.ts

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS notes_search_tokens TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS admin_notes_search_tokens TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_transactions_notes_search_tokens
  ON transactions USING GIN (notes_search_tokens);

CREATE INDEX IF NOT EXISTS idx_transactions_admin_notes_search_tokens
  ON transactions USING GIN (admin_notes_search_tokens);
