import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import { attachUserObject } from "../middleware/attachUserObject";
import { validate } from "../middleware/validation";
import {
  CreateVaultBodySchema,
  UpdateVaultBodySchema,
  TransferFundsBodySchema,
  VaultIdParamsSchema,
} from "../middleware/schemas/vaults";
import {
  createVault,
  getUserVaults,
  getVaultById,
  updateVault,
  deleteVault,
  transferFunds,
  getVaultTransactions,
  getUserBalanceSummary,
} from "../controllers/vaultController";

const router = Router();

// Apply authentication and user object attachment to all vault routes
router.use(authenticateToken);
router.use(attachUserObject);

// Vault management routes
router.post("/", validate({ body: CreateVaultBodySchema }), createVault);
router.get("/", getUserVaults);
router.get("/balance-summary", getUserBalanceSummary);
router.get("/:vaultId", validate({ params: VaultIdParamsSchema }), getVaultById);
router.put(
  "/:vaultId",
  validate({ body: UpdateVaultBodySchema, params: VaultIdParamsSchema }),
  updateVault,
);
router.delete("/:vaultId", validate({ params: VaultIdParamsSchema }), deleteVault);

// Vault transaction routes
router.post(
  "/:vaultId/transfer",
  validate({ body: TransferFundsBodySchema, params: VaultIdParamsSchema }),
  transferFunds,
);
router.get(
  "/:vaultId/transactions",
  validate({ params: VaultIdParamsSchema }),
  getVaultTransactions,
);

export { router as vaultRoutes };
