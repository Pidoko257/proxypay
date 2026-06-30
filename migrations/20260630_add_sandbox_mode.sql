
-- Add is_sandbox column to api_keys table
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS is_sandbox BOOLEAN DEFAULT FALSE NOT NULL;

-- Add is_sandbox column to transactions table
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_sandbox BOOLEAN DEFAULT FALSE NOT NULL;
