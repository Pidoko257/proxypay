-- Create table for database query performance baseline tracking
CREATE TABLE IF NOT EXISTS query_performance_baselines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_name VARCHAR(255) NOT NULL UNIQUE,
  baseline_ms DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  avg_duration_ms DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  sample_count BIGINT NOT NULL DEFAULT 0,
  last_execution_ms DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  slowdown_count BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_query_performance_baselines_name ON query_performance_baselines (query_name);
