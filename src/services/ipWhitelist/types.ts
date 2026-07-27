/**
 * IP Whitelist Types & Interfaces
 *
 * Configuration for trusted partners that bypass rate limiting
 */

/**
 * IP entry status
 */
export enum IPStatus {
  ACTIVE = "active",
  INACTIVE = "inactive",
  BLOCKED = "blocked",
  SUSPENDED = "suspended",
}

/**
 * Partner tier affecting rate limit bypass
 */
export enum PartnerTier {
  BASIC = "basic", // Limited bypass
  STANDARD = "standard", // Full bypass
  PREMIUM = "premium", // Unlimited + priority
  ENTERPRISE = "enterprise", // Full access + priority
}

/**
 * Whitelisted IP entry
 */
export interface WhitelistedIP {
  // Identification
  id: string; // UUID
  ipAddress: string; // Single IP or CIDR notation
  ipType: "single" | "cidr" | "range"; // IP format

  // Partner information
  partnerId: string; // Partner/organization ID
  partnerName: string; // Human-readable name
  tier: PartnerTier; // Rate limit tier
  contactEmail: string; // Support contact

  // Rate limiting bypass
  bypassRateLimit: boolean; // Bypass rate limiting entirely
  bypassApiKey?: string; // Optional API key for tracking
  customLimits?: {
    requestsPerSecond?: number;
    requestsPerMinute?: number;
    requestsPerHour?: number;
    requestsPerDay?: number;
    maxConcurrentRequests?: number;
  };

  // Status & tracking
  status: IPStatus;
  reason?: string; // Why whitelisted
  notes?: string; // Internal notes

  // Geolocation
  expectedCountries?: string[]; // Expected origin countries (ISO 3166-1 alpha-2)
  allowedEndpoints?: string[]; // Optional: restrict to specific endpoints
  allowedMethods?: string[]; // Optional: restrict to specific HTTP methods

  // Restrictions
  maxRequestsPerDay?: number; // Optional daily quota
  maintenanceMode?: boolean; // Disable without removing
  ipBlockedUntil?: number; // Timestamp for temporary blocks

  // Audit trail
  createdAt: number; // Timestamp
  createdBy: string; // Admin user ID
  updatedAt: number; // Last update timestamp
  updatedBy?: string; // Last updated by

  // Metadata
  tags?: string[]; // Custom categorization
  metadata?: Record<string, unknown>; // Additional data
  version: number; // Version for tracking changes
}

/**
 * Rate limit bypass result
 */
export interface RateLimitBypassResult {
  bypassed: boolean;
  reason?: string;
  tier?: PartnerTier;
  customLimits?: WhitelistedIP["customLimits"];
  remainingRequests?: number;
}

/**
 * IP whitelist statistics
 */
export interface WhitelistStats {
  totalWhitelisted: number;
  activeCount: number;
  inactiveCount: number;
  blockedCount: number;
  byTier: Record<PartnerTier, number>;
  totalPartners: number;
  lastUpdated: Date;
}

/**
 * Whitelist query options
 */
export interface WhitelistQueryOptions {
  status?: IPStatus;
  tier?: PartnerTier;
  partnerId?: string;
  bypassRateLimit?: boolean;
  search?: string; // Search by IP, partner name, or email
  limit?: number;
  offset?: number;
}

/**
 * Rate limit configuration per tier
 */
export interface TierRateLimitConfig {
  [PartnerTier.BASIC]: {
    bypassEnabled: boolean;
    limitOverride?: {
      requestsPerSecond: number;
      requestsPerMinute: number;
      requestsPerHour: number;
    };
  };
  [PartnerTier.STANDARD]: {
    bypassEnabled: boolean;
    limitOverride?: {
      requestsPerSecond: number;
      requestsPerMinute: number;
      requestsPerHour: number;
    };
  };
  [PartnerTier.PREMIUM]: {
    bypassEnabled: boolean;
    limitOverride?: {
      requestsPerSecond: number;
      requestsPerMinute: number;
      requestsPerHour: number;
    };
  };
  [PartnerTier.ENTERPRISE]: {
    bypassEnabled: boolean;
    limitOverride?: null; // No limits for enterprise
  };
}

/**
 * Whitelist configuration
 */
export interface WhitelistConfig {
  // Enable/disable feature
  enableWhitelist: boolean;

  // Storage
  storageProvider: "memory" | "database" | "redis";
  syncInterval?: number; // How often to sync from database (ms)

  // Caching
  enableCache: boolean;
  cacheTTL?: number; // Cache TTL in seconds

  // Logging
  enableLogging: boolean;
  logBypassedRequests: boolean;

  // Geolocation validation
  validateGeolocation: boolean;
  allowGeolocationMismatch: boolean;

  // Rate limit configuration by tier
  tierConfig: TierRateLimitConfig;

  // Default behavior
  blockUnwhitelisted: boolean; // If true, only whitelisted IPs allowed
  requireApiKey: boolean; // If true, require API key for bypass
}

/**
 * Access log entry for whitelisted IPs
 */
export interface WhitelistAccessLog {
  id: string;
  ipAddress: string;
  partnerId: string;
  timestamp: number;
  endpoint: string;
  method: string;
  statusCode: number;
  responseTimeMs: number;
  bypassRateLimit: boolean;
  rateLimitExceeded?: boolean; // If custom limits were hit
  userAgent?: string;
  errorMessage?: string;
}

/**
 * Whitelist manager interface
 */
export interface IWhitelistManager {
  // CRUD operations
  addIP(ip: WhitelistedIP): Promise<WhitelistedIP>;
  getIP(ipAddress: string): Promise<WhitelistedIP | null>;
  updateIP(ipAddress: string, updates: Partial<WhitelistedIP>): Promise<WhitelistedIP>;
  deleteIP(ipAddress: string): Promise<void>;
  listIPs(options?: WhitelistQueryOptions): Promise<WhitelistedIP[]>;

  // Query methods
  isWhitelisted(ipAddress: string): Promise<boolean>;
  canBypassRateLimit(ipAddress: string): Promise<RateLimitBypassResult>;
  getByPartner(partnerId: string): Promise<WhitelistedIP[]>;

  // Status checks
  isBlocked(ipAddress: string): Promise<boolean>;
  isSuspended(ipAddress: string): Promise<boolean>;

  // Management
  blockIP(ipAddress: string, reason?: string): Promise<void>;
  unblockIP(ipAddress: string): Promise<void>;
  suspendIP(ipAddress: string, reason?: string): Promise<void>;
  unsuspendIP(ipAddress: string): Promise<void>;

  // Statistics
  getStats(): Promise<WhitelistStats>;

  // Access logging
  logAccess(log: Omit<WhitelistAccessLog, "id">): Promise<void>;
  getAccessLogs(ipAddress: string, limit?: number): Promise<WhitelistAccessLog[]>;

  // Cache management
  clearCache(): Promise<void>;
  syncFromDatabase(): Promise<void>;
}

/**
 * IP pattern matcher
 */
export interface IPMatcher {
  matches(ip: string): boolean;
  pattern: string;
}
