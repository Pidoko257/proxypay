/**
 * IP Whitelist Manager Service
 *
 * Manages trusted partner IPs that can bypass rate limiting
 */

import ipaddr from "ipaddr.js";
import { v4 as uuidv4 } from "uuid";
import logger from "../../utils/logger";
import {
  WhitelistedIP,
  IPStatus,
  PartnerTier,
  RateLimitBypassResult,
  WhitelistStats,
  WhitelistQueryOptions,
  IWhitelistManager,
  WhitelistConfig,
  WhitelistAccessLog,
  TierRateLimitConfig,
} from "./types";

/**
 * IP Whitelist Manager Service
 */
export class WhitelistManager implements IWhitelistManager {
  private whitelistedIPs: Map<string, WhitelistedIP> = new Map();
  private accessLogs: Map<string, WhitelistAccessLog[]> = new Map();
  private config: WhitelistConfig;
  private cacheExpiry: Map<string, number> = new Map();
  private syncTimer: NodeJS.Timeout | null = null;

  constructor(config: WhitelistConfig) {
    this.config = config;

    // Start sync timer if using database storage
    if (config.storageProvider === "database" && config.syncInterval) {
      this.startSyncTimer();
    }

    logger.info("IP Whitelist Manager initialized", {
      enableWhitelist: config.enableWhitelist,
      storage: config.storageProvider,
    });
  }

  /**
   * Add IP to whitelist
   */
  async addIP(ip: WhitelistedIP): Promise<WhitelistedIP> {
    // Validate IP format
    if (!this.validateIPFormat(ip.ipAddress)) {
      throw new Error(`Invalid IP format: ${ip.ipAddress}`);
    }

    const whitelistEntry: WhitelistedIP = {
      ...ip,
      id: ip.id || uuidv4(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1,
    };

    this.whitelistedIPs.set(ip.ipAddress, whitelistEntry);
    this.invalidateCache(ip.ipAddress);

    logger.info("IP added to whitelist", {
      ipAddress: ip.ipAddress,
      partnerId: ip.partnerId,
      tier: ip.tier,
    });

    return whitelistEntry;
  }

  /**
   * Get IP from whitelist
   */
  async getIP(ipAddress: string): Promise<WhitelistedIP | null> {
    // Check cache first
    if (this.config.enableCache) {
      const cached = this.getFromCache(ipAddress);
      if (cached !== undefined) {
        return cached;
      }
    }

    const ip = this.whitelistedIPs.get(ipAddress) || null;

    // Cache result
    if (this.config.enableCache && ip) {
      this.setCache(ipAddress, ip);
    }

    return ip;
  }

  /**
   * Update IP whitelist entry
   */
  async updateIP(
    ipAddress: string,
    updates: Partial<WhitelistedIP>
  ): Promise<WhitelistedIP> {
    const existing = this.whitelistedIPs.get(ipAddress);
    if (!existing) {
      throw new Error(`IP not found: ${ipAddress}`);
    }

    const updated: WhitelistedIP = {
      ...existing,
      ...updates,
      ipAddress: existing.ipAddress, // Don't allow changing IP
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
      version: existing.version + 1,
    };

    this.whitelistedIPs.set(ipAddress, updated);
    this.invalidateCache(ipAddress);

    logger.info("IP whitelist entry updated", {
      ipAddress,
      changes: Object.keys(updates),
    });

    return updated;
  }

  /**
   * Delete IP from whitelist
   */
  async deleteIP(ipAddress: string): Promise<void> {
    this.whitelistedIPs.delete(ipAddress);
    this.accessLogs.delete(ipAddress);
    this.invalidateCache(ipAddress);

    logger.info("IP removed from whitelist", { ipAddress });
  }

  /**
   * List IPs with filtering
   */
  async listIPs(options?: WhitelistQueryOptions): Promise<WhitelistedIP[]> {
    let results = Array.from(this.whitelistedIPs.values());

    // Apply filters
    if (options?.status) {
      results = results.filter((ip) => ip.status === options.status);
    }

    if (options?.tier) {
      results = results.filter((ip) => ip.tier === options.tier);
    }

    if (options?.partnerId) {
      results = results.filter((ip) => ip.partnerId === options.partnerId);
    }

    if (options?.bypassRateLimit !== undefined) {
      results = results.filter(
        (ip) => ip.bypassRateLimit === options.bypassRateLimit
      );
    }

    // Search
    if (options?.search) {
      const search = options.search.toLowerCase();
      results = results.filter(
        (ip) =>
          ip.ipAddress.toLowerCase().includes(search) ||
          ip.partnerName.toLowerCase().includes(search) ||
          ip.contactEmail.toLowerCase().includes(search)
      );
    }

    // Sort by creation date (newest first)
    results.sort((a, b) => b.createdAt - a.createdAt);

    // Pagination
    const offset = options?.offset || 0;
    const limit = options?.limit || 100;

    return results.slice(offset, offset + limit);
  }

  /**
   * Check if IP is whitelisted
   */
  async isWhitelisted(ipAddress: string): Promise<boolean> {
    const ip = await this.getIP(ipAddress);
    if (!ip) {
      return false;
    }

    // Check status
    if (ip.status !== IPStatus.ACTIVE) {
      return false;
    }

    // Check if blocked temporarily
    if (ip.ipBlockedUntil && ip.ipBlockedUntil > Date.now()) {
      return false;
    }

    return true;
  }

  /**
   * Check if IP can bypass rate limiting
   */
  async canBypassRateLimit(ipAddress: string): Promise<RateLimitBypassResult> {
    if (!this.config.enableWhitelist) {
      return { bypassed: false, reason: "Whitelist disabled" };
    }

    const ip = await this.getIP(ipAddress);

    if (!ip) {
      return { bypassed: false, reason: "IP not whitelisted" };
    }

    // Check status
    if (ip.status === IPStatus.BLOCKED) {
      return { bypassed: false, reason: "IP is blocked" };
    }

    if (ip.status === IPStatus.SUSPENDED) {
      return { bypassed: false, reason: "IP is suspended" };
    }

    if (ip.status !== IPStatus.ACTIVE) {
      return { bypassed: false, reason: "IP is inactive" };
    }

    // Check temporary block
    if (ip.ipBlockedUntil && ip.ipBlockedUntil > Date.now()) {
      return {
        bypassed: false,
        reason: `IP temporarily blocked until ${new Date(ip.ipBlockedUntil).toISOString()}`,
      };
    }

    // Check maintenance mode
    if (ip.maintenanceMode) {
      return { bypassed: false, reason: "IP in maintenance mode" };
    }

    // Check if bypass is enabled
    if (!ip.bypassRateLimit) {
      return { bypassed: false, reason: "Rate limit bypass disabled for IP" };
    }

    // Return success with tier and custom limits
    return {
      bypassed: true,
      tier: ip.tier,
      customLimits: ip.customLimits,
    };
  }

  /**
   * Get IPs for a specific partner
   */
  async getByPartner(partnerId: string): Promise<WhitelistedIP[]> {
    const results = Array.from(this.whitelistedIPs.values()).filter(
      (ip) => ip.partnerId === partnerId
    );

    return results.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Check if IP is blocked
   */
  async isBlocked(ipAddress: string): Promise<boolean> {
    const ip = await this.getIP(ipAddress);
    return ip?.status === IPStatus.BLOCKED;
  }

  /**
   * Check if IP is suspended
   */
  async isSuspended(ipAddress: string): Promise<boolean> {
    const ip = await this.getIP(ipAddress);
    return ip?.status === IPStatus.SUSPENDED;
  }

  /**
   * Block an IP
   */
  async blockIP(ipAddress: string, reason?: string): Promise<void> {
    const ip = await this.getIP(ipAddress);
    if (!ip) {
      throw new Error(`IP not found: ${ipAddress}`);
    }

    await this.updateIP(ipAddress, {
      status: IPStatus.BLOCKED,
      reason: reason || "Manually blocked",
    });

    logger.warn("IP blocked", { ipAddress, reason });
  }

  /**
   * Unblock an IP
   */
  async unblockIP(ipAddress: string): Promise<void> {
    const ip = await this.getIP(ipAddress);
    if (!ip) {
      throw new Error(`IP not found: ${ipAddress}`);
    }

    await this.updateIP(ipAddress, {
      status: IPStatus.ACTIVE,
      reason: undefined,
    });

    logger.info("IP unblocked", { ipAddress });
  }

  /**
   * Suspend an IP
   */
  async suspendIP(ipAddress: string, reason?: string): Promise<void> {
    const ip = await this.getIP(ipAddress);
    if (!ip) {
      throw new Error(`IP not found: ${ipAddress}`);
    }

    await this.updateIP(ipAddress, {
      status: IPStatus.SUSPENDED,
      reason: reason || "Manually suspended",
    });

    logger.warn("IP suspended", { ipAddress, reason });
  }

  /**
   * Unsuspend an IP
   */
  async unsuspendIP(ipAddress: string): Promise<void> {
    const ip = await this.getIP(ipAddress);
    if (!ip) {
      throw new Error(`IP not found: ${ipAddress}`);
    }

    await this.updateIP(ipAddress, {
      status: IPStatus.ACTIVE,
      reason: undefined,
    });

    logger.info("IP unsuspended", { ipAddress });
  }

  /**
   * Get whitelist statistics
   */
  async getStats(): Promise<WhitelistStats> {
    const all = Array.from(this.whitelistedIPs.values());

    const stats: WhitelistStats = {
      totalWhitelisted: all.length,
      activeCount: all.filter((ip) => ip.status === IPStatus.ACTIVE).length,
      inactiveCount: all.filter((ip) => ip.status === IPStatus.INACTIVE).length,
      blockedCount: all.filter((ip) => ip.status === IPStatus.BLOCKED).length,
      byTier: {
        [PartnerTier.BASIC]: all.filter((ip) => ip.tier === PartnerTier.BASIC)
          .length,
        [PartnerTier.STANDARD]: all.filter((ip) => ip.tier === PartnerTier.STANDARD)
          .length,
        [PartnerTier.PREMIUM]: all.filter((ip) => ip.tier === PartnerTier.PREMIUM)
          .length,
        [PartnerTier.ENTERPRISE]: all.filter(
          (ip) => ip.tier === PartnerTier.ENTERPRISE
        ).length,
      },
      totalPartners: new Set(all.map((ip) => ip.partnerId)).size,
      lastUpdated: new Date(),
    };

    return stats;
  }

  /**
   * Log access for whitelisted IP
   */
  async logAccess(log: Omit<WhitelistAccessLog, "id">): Promise<void> {
    if (!this.config.logBypassedRequests) {
      return;
    }

    const entry: WhitelistAccessLog = {
      ...log,
      id: uuidv4(),
    };

    // Store access log
    const logs = this.accessLogs.get(log.ipAddress) || [];
    logs.push(entry);

    // Keep only recent logs (last 1000)
    if (logs.length > 1000) {
      logs.shift();
    }

    this.accessLogs.set(log.ipAddress, logs);
  }

  /**
   * Get access logs for IP
   */
  async getAccessLogs(
    ipAddress: string,
    limit: number = 100
  ): Promise<WhitelistAccessLog[]> {
    const logs = this.accessLogs.get(ipAddress) || [];
    return logs.slice(-limit);
  }

  /**
   * Clear cache
   */
  async clearCache(): Promise<void> {
    this.cacheExpiry.clear();
    logger.info("Whitelist cache cleared");
  }

  /**
   * Sync from database
   */
  async syncFromDatabase(): Promise<void> {
    // This would sync from database if configured
    logger.debug("Whitelist sync from database triggered");
    // TODO: Implement database sync
  }

  // ========================================================================
  // PRIVATE METHODS
  // ========================================================================

  /**
   * Validate IP format (IPv4, IPv6, CIDR, range)
   */
  private validateIPFormat(ip: string): boolean {
    try {
      // Try single IP
      if (ipaddr.isValid(ip)) {
        return true;
      }

      // Try CIDR
      if (ip.includes("/")) {
        const [addr, prefix] = ip.split("/");
        ipaddr.parseCIDR(ip);
        return true;
      }

      // Try IP range (e.g., 192.168.1.1-192.168.1.10)
      if (ip.includes("-")) {
        const [start, end] = ip.split("-");
        return ipaddr.isValid(start) && ipaddr.isValid(end);
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Get from cache
   */
  private getFromCache(ipAddress: string): WhitelistedIP | undefined {
    const expiry = this.cacheExpiry.get(ipAddress);

    if (expiry && expiry > Date.now()) {
      return this.whitelistedIPs.get(ipAddress);
    }

    return undefined;
  }

  /**
   * Set cache
   */
  private setCache(ipAddress: string, ip: WhitelistedIP): void {
    const ttl = (this.config.cacheTTL || 300) * 1000; // Default 5 minutes
    this.cacheExpiry.set(ipAddress, Date.now() + ttl);
  }

  /**
   * Invalidate cache for IP
   */
  private invalidateCache(ipAddress: string): void {
    this.cacheExpiry.delete(ipAddress);
  }

  /**
   * Start sync timer
   */
  private startSyncTimer(): void {
    const interval = (this.config.syncInterval || 60000); // Default 1 minute
    this.syncTimer = setInterval(() => {
      this.syncFromDatabase().catch((error) => {
        logger.error("Failed to sync whitelist from database", { error });
      });
    }, interval);
  }

  /**
   * Shutdown
   */
  async shutdown(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }
    logger.info("Whitelist manager shutdown", {
      totalWhitelisted: this.whitelistedIPs.size,
    });
  }
}

/**
 * Singleton instance
 */
let whitelistInstance: WhitelistManager | null = null;

/**
 * Get or create whitelist manager
 */
export async function getWhitelistManager(
  config?: WhitelistConfig
): Promise<WhitelistManager> {
  if (!whitelistInstance && config) {
    whitelistInstance = new WhitelistManager(config);
  }

  if (!whitelistInstance) {
    throw new Error("Whitelist manager not initialized");
  }

  return whitelistInstance;
}

export { WhitelistManager };
