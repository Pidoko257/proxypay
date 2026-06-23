-- Rollback: 20260428000000_create_anchored_assets
DROP TRIGGER IF EXISTS update_anchored_assets_updated_at ON anchored_assets;
DROP FUNCTION IF EXISTS update_anchored_assets_updated_at();
DROP TABLE IF EXISTS anchored_assets;
