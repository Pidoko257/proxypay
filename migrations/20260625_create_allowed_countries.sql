-- Stores the list of countries supported for payment processing.
-- enabled=true means the country is currently allowed; false means suspended.
CREATE TABLE IF NOT EXISTS allowed_countries (
  code       CHAR(2)     PRIMARY KEY,          -- ISO 3166-1 alpha-2
  name       VARCHAR(100) NOT NULL,
  enabled    BOOLEAN     NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed with an initial set of supported African countries
INSERT INTO allowed_countries (code, name) VALUES
  ('CM', 'Cameroon'),
  ('KE', 'Kenya'),
  ('GH', 'Ghana'),
  ('NG', 'Nigeria'),
  ('TZ', 'Tanzania'),
  ('UG', 'Uganda'),
  ('SN', 'Senegal'),
  ('CI', 'Côte d''Ivoire'),
  ('ZA', 'South Africa'),
  ('RW', 'Rwanda')
ON CONFLICT (code) DO NOTHING;
