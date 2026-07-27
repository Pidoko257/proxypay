/**
 * IP Whitelist Admin Routes
 */

import { Router, Request, Response } from "express";
import { adminAuthMiddleware, rbacMiddleware } from "../../middleware/auth";
import { getWhitelistManager } from "../../services/ipWhitelist/whitelistManager";
import { WhitelistedIP, PartnerTier, IPStatus } from "../../services/ipWhitelist/types";
import logger from "../../utils/logger";

const router = Router();

// Middleware
router.use(adminAuthMiddleware);
router.use(rbacMiddleware("admin:ip_whitelist", ["read", "write"]));

/**
 * GET /api/admin/whitelist/ips
 * List whitelisted IPs
 */
router.get("/whitelist/ips", async (req: Request, res: Response) => {
  try {
    const whitelistManager = await getWhitelistManager();
    const ips = await whitelistManager.listIPs({
      status: (req.query.status as any) || undefined,
      tier: (req.query.tier as any) || undefined,
      partnerId: req.query.partnerId as string,
      search: req.query.search as string,
      limit: parseInt(req.query.limit as string) || 100,
      offset: parseInt(req.query.offset as string) || 0,
    });

    res.json({ success: true, count: ips.length, ips });
  } catch (error) {
    logger.error("Failed to list whitelisted IPs", { error });
    res.status(500).json({ error: "Failed to list IPs" });
  }
});

/**
 * POST /api/admin/whitelist/ips
 * Add IP to whitelist
 */
router.post("/whitelist/ips", async (req: Request, res: Response) => {
  try {
    const whitelistManager = await getWhitelistManager();
    const ip = await whitelistManager.addIP({
      ipAddress: req.body.ipAddress,
      ipType: req.body.ipType || "single",
      partnerId: req.body.partnerId,
      partnerName: req.body.partnerName,
      tier: req.body.tier || PartnerTier.STANDARD,
      contactEmail: req.body.contactEmail,
      bypassRateLimit: req.body.bypassRateLimit !== false,
      customLimits: req.body.customLimits,
      status: req.body.status || IPStatus.ACTIVE,
      reason: req.body.reason,
      notes: req.body.notes,
      expectedCountries: req.body.expectedCountries,
      allowedEndpoints: req.body.allowedEndpoints,
      allowedMethods: req.body.allowedMethods,
      maxRequestsPerDay: req.body.maxRequestsPerDay,
      tags: req.body.tags,
      metadata: req.body.metadata,
      createdBy: (req as any).user?.id,
      id: undefined!,
      createdAt: 0,
      updatedAt: 0,
      version: 0,
    });

    logger.info("IP added to whitelist", {
      ipAddress: req.body.ipAddress,
      partnerId: req.body.partnerId,
      actor: (req as any).user?.id,
    });

    res.status(201).json({ success: true, ip });
  } catch (error) {
    logger.error("Failed to add IP to whitelist", { error });
    res.status(400).json({
      error: "Failed to add IP",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/admin/whitelist/ips/:ipAddress
 * Get specific whitelisted IP
 */
router.get("/whitelist/ips/:ipAddress", async (req: Request, res: Response) => {
  try {
    const whitelistManager = await getWhitelistManager();
    const ip = await whitelistManager.getIP(req.params.ipAddress);

    if (!ip) {
      return res.status(404).json({ error: "IP not found" });
    }

    res.json({ success: true, ip });
  } catch (error) {
    logger.error("Failed to get IP", { error });
    res.status(500).json({ error: "Failed to get IP" });
  }
});

/**
 * PATCH /api/admin/whitelist/ips/:ipAddress
 * Update whitelisted IP
 */
router.patch("/whitelist/ips/:ipAddress", async (req: Request, res: Response) => {
  try {
    const whitelistManager = await getWhitelistManager();
    const ip = await whitelistManager.updateIP(req.params.ipAddress, {
      ...req.body,
      updatedBy: (req as any).user?.id,
    });

    logger.info("IP updated in whitelist", {
      ipAddress: req.params.ipAddress,
      changes: Object.keys(req.body),
      actor: (req as any).user?.id,
    });

    res.json({ success: true, ip });
  } catch (error) {
    logger.error("Failed to update IP", { error });
    res.status(400).json({
      error: "Failed to update IP",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * DELETE /api/admin/whitelist/ips/:ipAddress
 * Delete whitelisted IP
 */
router.delete("/whitelist/ips/:ipAddress", async (req: Request, res: Response) => {
  try {
    const whitelistManager = await getWhitelistManager();
    await whitelistManager.deleteIP(req.params.ipAddress);

    logger.info("IP removed from whitelist", {
      ipAddress: req.params.ipAddress,
      actor: (req as any).user?.id,
    });

    res.json({ success: true, message: "IP removed" });
  } catch (error) {
    logger.error("Failed to delete IP", { error });
    res.status(500).json({ error: "Failed to delete IP" });
  }
});

/**
 * POST /api/admin/whitelist/ips/:ipAddress/block
 * Block an IP
 */
router.post("/whitelist/ips/:ipAddress/block", async (req: Request, res: Response) => {
  try {
    const whitelistManager = await getWhitelistManager();
    await whitelistManager.blockIP(req.params.ipAddress, req.body.reason);

    logger.warn("IP blocked", {
      ipAddress: req.params.ipAddress,
      reason: req.body.reason,
      actor: (req as any).user?.id,
    });

    res.json({ success: true, message: "IP blocked" });
  } catch (error) {
    res.status(400).json({ error: "Failed to block IP" });
  }
});

/**
 * POST /api/admin/whitelist/ips/:ipAddress/unblock
 * Unblock an IP
 */
router.post("/whitelist/ips/:ipAddress/unblock", async (req: Request, res: Response) => {
  try {
    const whitelistManager = await getWhitelistManager();
    await whitelistManager.unblockIP(req.params.ipAddress);

    logger.info("IP unblocked", {
      ipAddress: req.params.ipAddress,
      actor: (req as any).user?.id,
    });

    res.json({ success: true, message: "IP unblocked" });
  } catch (error) {
    res.status(400).json({ error: "Failed to unblock IP" });
  }
});

/**
 * GET /api/admin/whitelist/stats
 * Get whitelist statistics
 */
router.get("/whitelist/stats", async (req: Request, res: Response) => {
  try {
    const whitelistManager = await getWhitelistManager();
    const stats = await whitelistManager.getStats();
    res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ error: "Failed to get stats" });
  }
});

/**
 * GET /api/admin/whitelist/access-logs/:ipAddress
 * Get access logs for an IP
 */
router.get("/whitelist/access-logs/:ipAddress", async (req: Request, res: Response) => {
  try {
    const whitelistManager = await getWhitelistManager();
    const logs = await whitelistManager.getAccessLogs(
      req.params.ipAddress,
      parseInt(req.query.limit as string) || 100
    );

    res.json({ success: true, count: logs.length, logs });
  } catch (error) {
    res.status(500).json({ error: "Failed to get access logs" });
  }
});

/**
 * GET /api/admin/whitelist/partner/:partnerId
 * Get all IPs for a partner
 */
router.get("/whitelist/partner/:partnerId", async (req: Request, res: Response) => {
  try {
    const whitelistManager = await getWhitelistManager();
    const ips = await whitelistManager.getByPartner(req.params.partnerId);
    res.json({ success: true, count: ips.length, ips });
  } catch (error) {
    res.status(500).json({ error: "Failed to get partner IPs" });
  }
});

export default router;
