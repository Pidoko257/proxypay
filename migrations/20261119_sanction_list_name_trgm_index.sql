-- Migration: 20261119_sanction_list_name_trgm_index
-- Description: Enable pg_trgm and add a GIN trigram index on lower(name) so
-- SanctionService.searchSanctions can pre-filter fuzzy candidates inside
-- PostgreSQL (lower(name) % lower($1)) instead of loading the whole
-- sanction_list into Node.js and scoring every row.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_sanction_list_name_trgm
  ON sanction_list USING gin (lower(name) gin_trgm_ops);
