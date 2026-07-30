-- Migration: 20260730_create_provider_load_balancer
-- Description: Add tables for provider load balancing (Issue #203)

-- Provider capacity configuration
CREATE TABLE IF NOT EXISTS provider_capacity_config (
  provider                 VARCHAR(20)  PRIMARY KEY,
  max_concurrent_requests  INTEGER      NOT NULL DEFAULT 100,
  weight                   INTEGER      NOT NULL DEFAULT 33 CHECK (weight BETWEEN 1 AND 100),
  is_enabled               BOOLEAN      NOT NULL DEFAULT true,
  health_status            VARCHAR(20)  NOT NULL DEFAULT 'healthy'
                             CHECK (health_status IN ('healthy', 'degraded', 'unhealthy')),
  consecutive_failures     INTEGER      NOT NULL DEFAULT 0,
  last_health_check        TIMESTAMPTZ,
  avg_response_time_ms     INTEGER,
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed default providers
INSERT INTO provider_capacity_config (provider, weight) VALUES
  ('mtn',    34),
  ('airtel', 33),
  ('orange', 33)
ON CONFLICT (provider) DO NOTHING;

-- Load balancer global configuration
CREATE TABLE IF NOT EXISTS load_balancer_config (
  key         VARCHAR(50)  PRIMARY KEY,
  value       JSONB        NOT NULL,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed default config
INSERT INTO load_balancer_config (key, value)
VALUES (
  'default',
  '{"strategy":"round_robin","healthCheckIntervalMs":30000,"failureThreshold":3,"recoveryThreshold":2,"stickySessionTtlSeconds":300}'::jsonb
)
ON CONFLICT (key) DO NOTHING;

-- Per-request metrics for load balancer observability
CREATE TABLE IF NOT EXISTS provider_load_balancer_metrics (
  id           BIGSERIAL    PRIMARY KEY,
  provider     VARCHAR(20)  NOT NULL,
  success      BOOLEAN      NOT NULL,
  duration_ms  INTEGER,
  recorded_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lb_metrics_provider     ON provider_load_balancer_metrics (provider);
CREATE INDEX IF NOT EXISTS idx_lb_metrics_recorded_at  ON provider_load_balancer_metrics (recorded_at);
CREATE INDEX IF NOT EXISTS idx_lb_metrics_provider_ts  ON provider_load_balancer_metrics (provider, recorded_at DESC);
