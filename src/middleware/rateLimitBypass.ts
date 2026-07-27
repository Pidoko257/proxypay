/**
 * Rate Limit Bypass Middleware
 *
 * Integrates IP whitelist with rate limiting
 */

import { Request, Response, NextFunction } from "express";
import { getWhitelistManager } from "./whitelistManager";
import { resolveClientIp } from "../../utils/ipUtils";
import logger from "../../utils/logger";

/**
 * Middleware to check IP whitelist and bypass rate limiting
 */
export function createRateLimitBypassMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const clientIp = resolveClientIp(req);
      if (!clientIp) {
        return next();
      }

      const whitelistManager = await getWhitelistManager();
      const bypassResult = await whitelistManager.canBypassRateLimit(clientIp);

      // Store in request for later use
      (req as any).ipWhitelist = {
        isWhitelisted: bypassResult.bypassed,
        tier: bypassResult.tier,
        customLimits: bypassResult.customLimits,
        ipAddress: clientIp,
      };

      // Log if bypassing rate limit
      if (bypassResult.bypassed) {
        logger.debug("Rate limit bypassed for whitelisted IP", {
          ip: clientIp,
          tier: bypassResult.tier,
        });

        // Mark request to skip rate limiting
        (req as any).skipRateLimit = true;
      }

      next();
    } catch (error) {
      logger.error("Error checking IP whitelist", { error });
      next();
    }
  };
}

/**
 * Integrate with existing rate limit check
 */
export function shouldBypassRateLimit(req: Request): boolean {
  return (req as any).skipRateLimit === true;
}

/**
 * Get custom limits if applicable
 */
export function getCustomLimits(req: Request) {
  return (req as any).ipWhitelist?.customLimits;
}

/**
 * Get whitelist info
 */
export function getWhitelistInfo(req: Request) {
  return (req as any).ipWhitelist;
}
