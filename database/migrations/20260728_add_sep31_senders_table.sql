-- Migration: Add SEP-31 senders table
-- Description: Stores sender information for SEP-31 cross-border payments
-- Links senders to API keys/organizations for authorization

CREATE TABLE IF NOT EXISTS sep31_senders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id VARCHAR(255) NOT NULL,
  organization_id VARCHAR(255),
  
  -- Sender personal information
  first_name VARCHAR(255) NOT NULL,
  last_name VARCHAR(255) NOT NULL,
  email_address VARCHAR(255) NOT NULL,
  mobile_number VARCHAR(20),
  birth_date DATE,
  birth_place VARCHAR(255),
  birth_country VARCHAR(3),
  
  -- Address information
  address TEXT,
  address_country_code VARCHAR(3),
  state_or_province VARCHAR(100),
  city VARCHAR(100),
  postal_code VARCHAR(20),
  
  -- ID document information
  id_type VARCHAR(50),
  id_country_code VARCHAR(3),
  id_issue_date DATE,
  id_expiration_date DATE,
  id_number VARCHAR(100),
  
  -- Additional fields
  tax_id VARCHAR(50),
  tax_id_name VARCHAR(100),
  occupation VARCHAR(100),
  employer_name VARCHAR(255),
  employer_address TEXT,
  
  -- Metadata
  sep12_type VARCHAR(50) DEFAULT 'sep31-sender',
  status VARCHAR(20) NOT NULL DEFAULT 'ACCEPTED' CHECK (status IN ('ACCEPTED', 'PROCESSING', 'NEEDS_INFO', 'REJECTED')),
  
  -- Timestamps
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  -- Constraints
  UNIQUE(api_key_id, id_number)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_sep31_senders_api_key_id ON sep31_senders(api_key_id);
CREATE INDEX IF NOT EXISTS idx_sep31_senders_organization_id ON sep31_senders(organization_id);
CREATE INDEX IF NOT EXISTS idx_sep31_senders_email_address ON sep31_senders(email_address);
CREATE INDEX IF NOT EXISTS idx_sep31_senders_id_number ON sep31_senders(id_number);
CREATE INDEX IF NOT EXISTS idx_sep31_senders_status ON sep31_senders(status);
CREATE INDEX IF NOT EXISTS idx_sep31_senders_updated_at ON sep31_senders(updated_at);

-- Auto-update updated_at trigger
CREATE OR REPLACE FUNCTION update_sep31_senders_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sep31_senders_updated_at ON sep31_senders;
CREATE TRIGGER sep31_senders_updated_at
  BEFORE UPDATE ON sep31_senders
  FOR EACH ROW EXECUTE FUNCTION update_sep31_senders_updated_at();

-- Comments for documentation
COMMENT ON TABLE sep31_senders IS 'Stores sender information for SEP-31 cross-border payments, linked to API keys/organizations';
COMMENT ON COLUMN sep31_senders.api_key_id IS 'API key that registered this sender';
COMMENT ON COLUMN sep31_senders.organization_id IS 'Optional organization ID for multi-tenant setups';
COMMENT ON COLUMN sep31_senders.sep12_type IS 'SEP-12 customer type (sep31-sender)';
COMMENT ON COLUMN sep31_senders.status IS 'Current verification status per SEP-12 spec';
