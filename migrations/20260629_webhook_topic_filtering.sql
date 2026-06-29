-- Migration: 20260629_webhook_topic_filtering
-- Description: Add GIN index and topic-filtering support for merchant webhook event subscriptions.
--              The merchant_webhooks.events column already exists as TEXT[].
--              This migration adds:
--                1. A GIN index on events for fast topic-match queries.
--                2. A check constraint allowing the registered wildcard topic "transaction.*"
--                   in addition to the four concrete event names.

-- GIN index on merchant_webhooks.events for O(1) overlap / contains queries.
CREATE INDEX IF NOT EXISTS idx_merchant_webhooks_events
    ON merchant_webhooks USING GIN (events);

-- Allow the wildcard topic "transaction.*" alongside the four concrete event names.
-- Drop the existing check constraint (if any) and replace it with one that allows wildcards.
-- Note: the constraint name may not exist on all environments — use IF EXISTS guards.
ALTER TABLE merchant_webhooks
    DROP CONSTRAINT IF EXISTS merchant_webhooks_events_check;

ALTER TABLE merchant_webhooks
    ADD CONSTRAINT merchant_webhooks_events_check
    CHECK (
        events <@ ARRAY[
            'transaction.completed',
            'transaction.failed',
            'transaction.pending',
            'transaction.cancelled',
            'transaction.*'
        ]::TEXT[]
    );
