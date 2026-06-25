-- Rollback: 20260101000021_create_sanction_list
DROP TRIGGER IF EXISTS sanction_list_updated_at ON sanction_list;
DROP FUNCTION IF EXISTS update_sanction_list_updated_at();
DROP TABLE IF EXISTS sanction_list;
