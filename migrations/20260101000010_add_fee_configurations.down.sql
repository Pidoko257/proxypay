-- Rollback: 20260101000010_add_fee_configurations
DROP TRIGGER IF EXISTS fee_configurations_updated_at ON fee_configurations;
DROP FUNCTION IF EXISTS update_fee_configurations_updated_at();
DROP TABLE IF EXISTS fee_configuration_audit;
DROP TABLE IF EXISTS fee_configurations;
