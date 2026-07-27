-- Migration: 20260727_add_search_vector_to_transactions
-- Description: Add tsvector column, trigger, and GIN index for full-text search

-- Add search_vector column to the partitioned parent (propagates to all partitions)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- Create trigger function to auto-update search_vector
CREATE OR REPLACE FUNCTION transactions_search_vector_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    COALESCE(NEW.reference_number, '') || ' ' ||
    COALESCE(NEW.provider_reference, '') || ' ' ||
    COALESCE(NEW.type, '') || ' ' ||
    COALESCE(NEW.provider, '') || ' ' ||
    COALESCE(NEW.status, '') || ' ' ||
    COALESCE(array_to_string(NEW.tags, ' '), '') || ' ' ||
    COALESCE(NEW.currency, '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger on the parent (propagates to all partitions)
DROP TRIGGER IF EXISTS transactions_search_vector_update ON transactions;
CREATE TRIGGER transactions_search_vector_update
  BEFORE INSERT OR UPDATE OF reference_number, provider_reference, type, provider, status, tags, currency
  ON transactions
  FOR EACH ROW
  EXECUTE FUNCTION transactions_search_vector_update();

-- Create GIN index on the parent (propagates to all partitions)
CREATE INDEX IF NOT EXISTS idx_transactions_search_vector
  ON transactions USING GIN (search_vector);

-- Backfill search_vector for existing rows
UPDATE transactions
SET search_vector = to_tsvector('english',
  COALESCE(reference_number, '') || ' ' ||
  COALESCE(provider_reference, '') || ' ' ||
  COALESCE(type, '') || ' ' ||
  COALESCE(provider, '') || ' ' ||
  COALESCE(status, '') || ' ' ||
  COALESCE(array_to_string(tags, ' '), '') || ' ' ||
  COALESCE(currency, '')
)
WHERE search_vector IS NULL;
