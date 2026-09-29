CREATE TABLE IF NOT EXISTS compliance_document_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES compliance_documents(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  body TEXT NOT NULL,
  country_code VARCHAR(2),
  provider VARCHAR(100),
  tags TEXT[] NOT NULL DEFAULT '{}',
  source_url TEXT,
  status VARCHAR(20) NOT NULL,
  change_summary TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (document_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_compliance_document_versions_document_id
  ON compliance_document_versions (document_id);

CREATE INDEX IF NOT EXISTS idx_compliance_document_versions_document_version
  ON compliance_document_versions (document_id, version_number);
