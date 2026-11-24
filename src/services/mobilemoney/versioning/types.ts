/**
 * Provider API Versioning and Compatibility Types
 *
 * This module defines the core types for managing multiple provider API versions,
 * compatibility levels, and migration strategies.
 */

/**
 * Supported API versions
 */
export enum ProviderApiVersion {
  V1 = "v1", // Legacy API
  V2 = "v2", // Current/recommended API
  V3 = "v3", // Future API
}

/**
 * Routing strategy for determining which API version to use
 */
export enum VersionRoutingStrategy {
  /**
   * Use the specified version directly
   */
  FIXED = "fixed",

  /**
   * Gradually migrate traffic from old to new version
   * using a percentage-based canary rollout
   */
  CANARY = "canary",

  /**
   * Route based on transaction properties (amount, type, etc.)
   */
  CONDITIONAL = "conditional",

  /**
   * Try primary version first, fallback to secondary on failure
   */
  FAILOVER = "failover",

  /**
   * Split traffic between versions for A/B testing
   */
  SHADOW = "shadow",
}

/**
 * Compatibility level describes how well v1 operations map to v2
 */
export enum CompatibilityLevel {
  /**
   * Full compatibility - no mapping needed
   */
  FULL = "full",

  /**
   * Requires minor transformations (field mapping, etc)
   */
  COMPATIBLE = "compatible",

  /**
   * Requires significant adaptation (structure changes)
   */
  REQUIRES_BRIDGE = "requires_bridge",

  /**
   * Feature not available in target version
   */
  UNSUPPORTED = "unsupported",
}

/**
 * Configuration for a specific provider version
 */
export interface ProviderVersionConfig {
  version: ProviderApiVersion;
  enabled: boolean;
  baseUrl: string;
  endpoints: VersionEndpoints;
  requestTransform?: (req: unknown) => unknown;
  responseTransform?: (res: unknown) => unknown;
  timeout?: number;
  retryPolicy?: RetryPolicy;
  circuitBreaker?: CircuitBreakerConfig;
}

/**
 * Endpoint definitions for a specific API version
 */
export interface VersionEndpoints {
  requestPayment: string;
  sendPayout: string;
  getTransactionStatus: string;
  sendBatchPayout?: string;
  getBalance?: string;
}

/**
 * Retry policy configuration
 */
export interface RetryPolicy {
  maxRetries: number;
  backoffMultiplier: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeout: number;
}

/**
 * Version routing configuration for a specific provider
 */
export interface ProviderVersionRoutingConfig {
  provider: string;
  strategy: VersionRoutingStrategy;
  primaryVersion: ProviderApiVersion;
  secondaryVersion?: ProviderApiVersion;
  canaryConfig?: CanaryConfig;
  conditionalRules?: ConditionalRoutingRule[];
}

/**
 * Canary rollout configuration
 */
export interface CanaryConfig {
  /**
   * Percentage of traffic to send to new version (0-100)
   */
  trafficPercentage: number;

  /**
   * Start time for canary rollout
   */
  startTime?: Date;

  /**
   * End time for canary rollout (all traffic switches to new version)
   */
  completionTime?: Date;

  /**
   * Maximum error rate before rollback (0-1)
   */
  maxErrorRate?: number;

  /**
   * Session affinity - ensure same user always gets same version
   */
  sessionAffinity?: boolean;
}

/**
 * Conditional routing rule
 */
export interface ConditionalRoutingRule {
  condition: (context: TransactionContext) => boolean;
  version: ProviderApiVersion;
  priority: number; // Higher priority rules evaluated first
}

/**
 * Transaction context for routing decisions
 */
export interface TransactionContext {
  provider: string;
  phoneNumber: string;
  amount: number;
  userId?: string;
  sessionId?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * API request/response mapping for compatibility bridging
 */
export interface CompatibilityMapping {
  sourceVersion: ProviderApiVersion;
  targetVersion: ProviderApiVersion;
  requestMapper: (req: unknown) => unknown;
  responseMapper: (res: unknown) => unknown;
}

/**
 * Migration progress tracking
 */
export interface MigrationProgress {
  provider: string;
  sourceVersion: ProviderApiVersion;
  targetVersion: ProviderApiVersion;
  startDate: Date;
  expectedCompletionDate: Date;
  currentTrafficPercentage: number;
  status: "planning" | "in_progress" | "completed" | "rolled_back";
  metrics: MigrationMetrics;
}

/**
 * Metrics collected during migration
 */
export interface MigrationMetrics {
  totalTransactions: number;
  successCount: number;
  failureCount: number;
  avgLatencyMs: number;
  errorRate: number;
  rollbackCount: number;
  usersFailed: Set<string>;
}

/**
 * Result of a provider operation with version info
 */
export interface VersionedOperationResult {
  success: boolean;
  data?: unknown;
  error?: unknown;
  apiVersion: ProviderApiVersion;
  executionTimeMs: number;
  retried: boolean;
  fallbackUsed: boolean;
}

/**
 * Configuration container for all providers and versions
 */
export interface VersionedProviderConfig {
  providers: {
    [provider: string]: {
      versions: {
        [key in ProviderApiVersion]?: ProviderVersionConfig;
      };
      routing: ProviderVersionRoutingConfig;
    };
  };
  globalCanaryConfig?: Partial<CanaryConfig>;
  enableMetrics: boolean;
  enableLogging: boolean;
}
