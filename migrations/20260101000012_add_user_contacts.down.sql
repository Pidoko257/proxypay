-- Rollback: 20260101000012_add_user_contacts
DROP TRIGGER IF EXISTS user_contacts_updated_at ON user_contacts;
DROP FUNCTION IF EXISTS update_user_contacts_updated_at();
DROP TABLE IF EXISTS user_contacts;
