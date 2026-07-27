import { Router } from "express";
import {
  getTwoFactorStatus,
  setupTwoFactor,
  enableTwoFactor,
  disableTwoFactor,
  verifyTwoFactor,
  regenerateBackupCodes,
  addTrustedDevice,
  listTrustedDevices,
  deleteTrustedDevice,
} from "../controllers/twoFactorController";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.use(requireAuth);

router.get("/status", getTwoFactorStatus);
router.post("/setup", setupTwoFactor);
router.post("/enable", enableTwoFactor);
router.post("/disable", disableTwoFactor);
router.post("/verify", verifyTwoFactor);
router.post("/backup-codes/regenerate", regenerateBackupCodes);
router.post("/trusted-devices", addTrustedDevice);
router.get("/trusted-devices", listTrustedDevices);
router.delete("/trusted-devices/:deviceId", deleteTrustedDevice);

export { router as twoFactorRoutes };
