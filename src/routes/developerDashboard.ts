import { Router } from "express";
import { DeveloperDashboardController } from "../controllers/developerDashboardController";
import { ApiKeyController } from "../controllers/apiKeyController";
import { authenticateToken, requireAuth } from "../middleware/auth";

export const developerDashboardRoutes = Router();

/**
 * @route   GET /api/developer/dashboard
 * @desc    Get API rate limit usage stats for the authenticated partner
 * @access  Private
 */
developerDashboardRoutes.get("/dashboard", requireAuth, DeveloperDashboardController.getDashboard);
developerDashboardRoutes.post("/api-keys", authenticateToken, ApiKeyController.create);
developerDashboardRoutes.get("/api-keys", authenticateToken, ApiKeyController.list);
