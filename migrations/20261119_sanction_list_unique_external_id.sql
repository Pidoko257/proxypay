-- Migration: 20261119_sanction_list_unique_external_id
-- Description: SanctionService.updateSanctionList upserts with
-- ON CONFLICT (external_id, source), which requires a matching unique index.
-- Migration 011 only created a non-unique index, so add the unique one.
--
-- Existing duplicate (external_id, source) rows are NOT removed automatically;
-- the migration aborts with a clear message so an operator can review them.

DO $$
DECLARE
  dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT 1
    FROM sanction_list
    WHERE external_id IS NOT NULL
    GROUP BY external_id, source
    HAVING COUNT(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'sanction_list has % duplicate (external_id, source) groups; resolve them before adding uq_sanction_list_external_id_source',
      dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sanction_list_external_id_source
  ON sanction_list (external_id, source);
