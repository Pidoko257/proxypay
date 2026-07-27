import { Router } from "express";
import { requireAuth } from "../../middleware/auth";

import {
  listUserAssetPreferences,
  getUserPreferredAsset,
  createAssetPreference,
  setPreferredAsset,
  deleteAssetPreference,
  listAvailableAssets,
  getUserSettlementAsset,
} from "../../controllers/assetCustomizationController";

const router = Router();

router.get("/preferences", requireAuth, listUserAssetPreferences);
router.get("/preferred", requireAuth, getUserPreferredAsset);
router.post("/preferences", requireAuth, createAssetPreference);
router.put("/preferences/:preferenceId/preferred", requireAuth, setPreferredAsset);
router.delete("/preferences/:preferenceId", requireAuth, deleteAssetPreference);
router.get("/", listAvailableAssets);
router.get("/settlement", requireAuth, getUserSettlementAsset);

export { router as assetRoutes };
