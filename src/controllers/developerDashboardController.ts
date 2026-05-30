import { Request, Response } from "express";
import { DeveloperDashboardService } from "../services/developerDashboardService";

const service = new DeveloperDashboardService();

export class DeveloperDashboardController {
  /**
   * GET /api/developer/dashboard
   * Returns rate limit usage stats for the authenticated partner
   */
  static async getDashboard(req: Request, res: Response) {
    try {
      const partnerId = (req as any).user?.id;
      if (!partnerId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const stats = await service.getUsageStats(partnerId);
      return res.json(stats);
    } catch (error) {
      console.error("Developer dashboard error:", error);
      return res.status(500).json({ error: "Failed to fetch dashboard stats" });
    }
  }
}
