-- Rollback: 20260101000011_encrypt_pii_fields
-- Restore original VARCHAR column sizes (columns exist; TYPE change is safe)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'phone_number') THEN
    ALTER TABLE transactions ALTER COLUMN phone_number TYPE VARCHAR(20);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'stellar_address') THEN
    ALTER TABLE transactions ALTER COLUMN stellar_address TYPE VARCHAR(56);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'phone_number') THEN
    ALTER TABLE users ALTER COLUMN phone_number TYPE VARCHAR(20);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'email') THEN
    ALTER TABLE users ALTER COLUMN email TYPE VARCHAR(255);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'two_factor_secret') THEN
    ALTER TABLE users ALTER COLUMN two_factor_secret TYPE VARCHAR(32);
  END IF;
END $$;
