-- Rollback: 20261119_create_fraud_high_risk_numbers

DROP INDEX IF EXISTS idx_fraud_high_risk_numbers_active;
DROP TABLE IF EXISTS fraud_high_risk_numbers;
