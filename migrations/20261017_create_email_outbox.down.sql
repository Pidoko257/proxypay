-- Rollback: 20261017_create_email_outbox

DROP INDEX IF EXISTS idx_email_outbox_status_created;
DROP INDEX IF EXISTS idx_email_outbox_related_entity;
DROP INDEX IF EXISTS idx_email_outbox_user_id_created;
DROP INDEX IF EXISTS idx_email_outbox_type_status;
DROP INDEX IF EXISTS idx_email_outbox_dedup_key;
DROP INDEX IF EXISTS idx_email_outbox_status_next_retry;

DROP TABLE IF EXISTS email_outbox CASCADE;
