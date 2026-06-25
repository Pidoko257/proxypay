-- Rollback: 20260424000002_create_provider_api_calls
DROP TRIGGER IF EXISTS trg_trim_provider_api_calls ON provider_api_calls;
DROP FUNCTION IF EXISTS trim_provider_api_calls();
DROP TABLE IF EXISTS provider_api_calls;
