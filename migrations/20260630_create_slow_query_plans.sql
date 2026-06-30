-- Issue #232: Store EXPLAIN ANALYZE output for slow queries (>500ms)
CREATE TABLE IF NOT EXISTS slow_query_plans (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query      TEXT NOT NULL,
  params     JSONB,
  duration_ms INTEGER NOT NULL,
  plan       JSONB NOT NULL,
  executed_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_slow_query_plans_created_at ON slow_query_plans (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_slow_query_plans_duration_ms ON slow_query_plans (duration_ms DESC);
