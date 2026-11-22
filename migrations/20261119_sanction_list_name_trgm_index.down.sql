-- Rollback: 20261119_sanction_list_name_trgm_index
-- The pg_trgm extension is left installed because other objects may depend on it.
DROP INDEX IF EXISTS idx_sanction_list_name_trgm;
