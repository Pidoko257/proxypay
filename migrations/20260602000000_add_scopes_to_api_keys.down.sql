-- Rollback: 20260602000000_add_scopes_to_api_keys
ALTER TABLE api_keys DROP COLUMN IF EXISTS scopes;
