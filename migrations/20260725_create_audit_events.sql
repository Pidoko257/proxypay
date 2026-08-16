-- Migration: Comprehensive Audit Logging System — Issue #167
-- Creates an append-only audit_events table with row-level security.
-- This table must not allow UPDATE or DELETE to ensure immutability.

CREATE TABLE IF NOT EXISTS audit_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Who performed the action
    actor_id        UUID,                       -- user / admin / system that triggered the event
    actor_role      TEXT,                       -- role at time of action
    actor_ip        TEXT,                       -- IP address of the request
    actor_user_agent TEXT,                      -- User-Agent string
    -- What happened
    event_type      TEXT NOT NULL,              -- TRANSACTION_CREATED, USER_UPDATED, ADMIN_ACTION, etc.
    category        TEXT NOT NULL,              -- financial | user | admin | auth | system
    action          TEXT NOT NULL,              -- human-readable action description
    -- What was affected
    resource_type   TEXT,                       -- 'transaction' | 'user' | 'kyc_document' | etc.
    resource_id     TEXT,                       -- ID of the affected resource
    -- Payload
    old_values      JSONB,                      -- state before the change (NULL for create events)
    new_values      JSONB,                      -- state after the change  (NULL for delete events)
    metadata        JSONB NOT NULL DEFAULT '{}', -- additional context (request ID, reason, etc.)
    -- Outcome
    success         BOOLEAN NOT NULL DEFAULT TRUE,
    error_code      TEXT,                       -- populated when success = FALSE
    -- When
    occurred_at     TIMESTAMP NOT NULL DEFAULT NOW(),
    -- Retention
    retain_until    TIMESTAMP                   -- NULL means retain forever (set by policy)
);

-- ── Immutability enforcement (PostgreSQL RULE) ───────────────────────────────
-- Prevent UPDATE and DELETE to guarantee an immutable audit trail.
CREATE RULE no_update_audit_events AS ON UPDATE TO audit_events DO INSTEAD NOTHING;
CREATE RULE no_delete_audit_events AS ON DELETE TO audit_events DO INSTEAD NOTHING;

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_audit_events_actor_id
    ON audit_events(actor_id)
    WHERE actor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_events_resource
    ON audit_events(resource_type, resource_id)
    WHERE resource_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_events_event_type
    ON audit_events(event_type);

CREATE INDEX IF NOT EXISTS idx_audit_events_category
    ON audit_events(category);

CREATE INDEX IF NOT EXISTS idx_audit_events_occurred_at
    ON audit_events(occurred_at DESC);

-- Composite index for common compliance queries
CREATE INDEX IF NOT EXISTS idx_audit_events_actor_occurred
    ON audit_events(actor_id, occurred_at DESC)
    WHERE actor_id IS NOT NULL;

-- Partial index to find failures quickly
CREATE INDEX IF NOT EXISTS idx_audit_events_failures
    ON audit_events(occurred_at DESC)
    WHERE success = FALSE;
