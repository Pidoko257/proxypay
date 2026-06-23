-- Rollback: 20260424000001_create_fee_strategies
DROP TRIGGER IF EXISTS fee_strategies_updated_at ON fee_strategies;
DROP FUNCTION IF EXISTS update_fee_strategies_updated_at();
DROP TABLE IF EXISTS fee_strategy_audit;
DROP TABLE IF EXISTS fee_strategies;
DROP TYPE IF EXISTS fee_strategy_scope;
DROP TYPE IF EXISTS fee_strategy_type;
