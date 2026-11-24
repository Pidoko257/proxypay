/**
 * Version-Aware Provider Loader with Fallback Logic
 *
 * Handles intelligent loading, routing, and fallback between different
 * API versions with canary support and gradual migration.
 */

import {
  ProviderApiVersion,
  VersionRoutingStrategy,
  TransactionContext,
  VersionedOperationResult,
  CanaryConfig,
  ConditionalRoutingRule,
  ProviderVersionRoutingConfig,
} from "./types";
import { CompatibilityAdapter, VersionAdapterFactory } from "./adapter";
import logger from "../../../utils/logger";

/**
 * Version routing engine for intelligent version selection
 */
export class VersionRouter {
  private config: ProviderVersionRoutingConfig;
  private adapter: CompatibilityAdapter;
  private factory: VersionAdapterFactory;
  private canaryState: CanaryState;
  private performanceMetrics: Map<ProviderApiVersion, PerformanceMetrics> =
    new Map();

  constructor(
    config: ProviderVersionRoutingConfig,
    adapter: CompatibilityAdapter,
    factory: VersionAdapterFactory
  ) {
    this.config = config;
    this.adapter = adapter;
    this.factory = factory;
    this.canaryState = this.initializeCanaryState();
  }

  /**
   * Initialize canary state from config
   */
  private initializeCanaryState(): CanaryState {
    const canaryConfig = this.config.canaryConfig;
    return {
      enabled: (canaryConfig?.trafficPercentage || 0) > 0,
      trafficPercentage: canaryConfig?.trafficPercentage || 0,
      startTime: canaryConfig?.startTime || new Date(),
      sessionAffinity: canaryConfig?.sessionAffinity || false,
      sessionMapping: new Map(),
      errorRate: 0,
      maxErrorRate: canaryConfig?.maxErrorRate || 0.05,
    };
  }

  /**
   * Determine which version to use for a transaction
   */
  selectVersion(
    context: TransactionContext
  ): { version: ProviderApiVersion; reason: string } {
    const strategy = this.config.strategy;

    switch (strategy) {
      case VersionRoutingStrategy.FIXED:
        return this.selectVersionFixed(context);

      case VersionRoutingStrategy.CANARY:
        return this.selectVersionCanary(context);

      case VersionRoutingStrategy.CONDITIONAL:
        return this.selectVersionConditional(context);

      case VersionRoutingStrategy.FAILOVER:
        return this.selectVersionFailover(context);

      case VersionRoutingStrategy.SHADOW:
        return this.selectVersionShadow(context);

      default:
        return this.selectVersionFixed(context);
    }
  }

  /**
   * Fixed version selection (always use primary version)
   */
  private selectVersionFixed(
    _context: TransactionContext
  ): { version: ProviderApiVersion; reason: string } {
    return {
      version: this.config.primaryVersion,
      reason: "fixed_strategy",
    };
  }

  /**
   * Canary version selection (gradual traffic shift)
   */
  private selectVersionCanary(context: TransactionContext): {
    version: ProviderApiVersion;
    reason: string;
  } {
    if (!this.canaryState.enabled) {
      return {
        version: this.config.primaryVersion,
        reason: "canary_disabled",
      };
    }

    // Session affinity - always route same user to same version
    if (
      this.canaryState.sessionAffinity &&
      context.sessionId &&
      this.canaryState.sessionMapping.has(context.sessionId)
    ) {
      const version = this.canaryState.sessionMapping.get(context.sessionId)!;
      return {
        version,
        reason: "canary_session_affinity",
      };
    }

    // Canary: route percentage of traffic to secondary version
    const random = Math.random() * 100;
    const useSecondary =
      random < this.canaryState.trafficPercentage &&
      this.config.secondaryVersion;

    if (useSecondary) {
      if (this.canaryState.sessionAffinity && context.sessionId) {
        this.canaryState.sessionMapping.set(context.sessionId, this.config.secondaryVersion!);
      }
      return {
        version: this.config.secondaryVersion!,
        reason: "canary_rollout",
      };
    }

    if (this.canaryState.sessionAffinity && context.sessionId) {
      this.canaryState.sessionMapping.set(context.sessionId, this.config.primaryVersion);
    }

    return {
      version: this.config.primaryVersion,
      reason: "canary_primary",
    };
  }

  /**
   * Conditional version selection (based on transaction properties)
   */
  private selectVersionConditional(context: TransactionContext): {
    version: ProviderApiVersion;
    reason: string;
  } {
    if (!this.config.conditionalRules || this.config.conditionalRules.length === 0) {
      return {
        version: this.config.primaryVersion,
        reason: "no_conditional_rules",
      };
    }

    // Sort rules by priority and evaluate
    const sortedRules = [...this.config.conditionalRules].sort(
      (a, b) => b.priority - a.priority
    );

    for (const rule of sortedRules) {
      try {
        if (rule.condition(context)) {
          return {
            version: rule.version,
            reason: `conditional_rule_priority_${rule.priority}`,
          };
        }
      } catch (error) {
        logger.warn(
          `Error evaluating conditional rule for ${this.config.provider}:`,
          error
        );
      }
    }

    return {
      version: this.config.primaryVersion,
      reason: "no_matching_conditional_rules",
    };
  }

  /**
   * Failover version selection (use secondary on primary failure)
   */
  private selectVersionFailover(
    _context: TransactionContext
  ): { version: ProviderApiVersion; reason: string } {
    // In the context of this method, we select the primary
    // Actual failover happens when operation fails
    return {
      version: this.config.primaryVersion,
      reason: "failover_primary",
    };
  }

  /**
   * Shadow version selection (use primary, shadow secondary)
   */
  private selectVersionShadow(
    _context: TransactionContext
  ): { version: ProviderApiVersion; reason: string } {
    return {
      version: this.config.primaryVersion,
      reason: "shadow_primary",
    };
  }

  /**
   * Record transaction performance metrics
   */
  recordPerformance(
    version: ProviderApiVersion,
    success: boolean,
    durationMs: number
  ): void {
    const metrics = this.performanceMetrics.get(version) || {
      calls: 0,
      successes: 0,
      failures: 0,
      totalDurationMs: 0,
    };

    metrics.calls++;
    metrics.totalDurationMs += durationMs;

    if (success) {
      metrics.successes++;
    } else {
      metrics.failures++;
    }

    this.performanceMetrics.set(version, metrics);

    // Update canary error rate
    if (this.canaryState.enabled) {
      const totalCanaryCalls = metrics.calls;
      const canaryFailures = metrics.failures;
      this.canaryState.errorRate = canaryFailures / totalCanaryCalls;

      if (this.canaryState.errorRate > this.canaryState.maxErrorRate) {
        logger.warn(
          `Canary error rate for ${this.config.provider} version ${version} exceeded threshold: ${this.canaryState.errorRate}`
        );
      }
    }
  }

  /**
   * Get performance metrics for all versions
   */
  getPerformanceMetrics(): Map<ProviderApiVersion, PerformanceMetrics> {
    return new Map(this.performanceMetrics);
  }

  /**
   * Check if canary is ready to complete
   */
  isCanaryComplete(): boolean {
    if (!this.canaryState.enabled) {
      return false;
    }

    // Canary is complete when traffic percentage is 100%
    return this.canaryState.trafficPercentage >= 100;
  }

  /**
   * Update canary traffic percentage
   */
  updateCanaryTraffic(percentage: number): void {
    this.canaryState.trafficPercentage = Math.min(100, Math.max(0, percentage));
    logger.info(
      `Updated canary traffic for ${this.config.provider} to ${percentage}%`
    );
  }

  /**
   * Rollback canary to primary version
   */
  rollbackCanary(): void {
    this.canaryState.enabled = false;
    this.canaryState.sessionMapping.clear();
    logger.warn(
      `Rolled back canary for ${this.config.provider}, using primary version`
    );
  }
}

/**
 * Performance metrics for a version
 */
interface PerformanceMetrics {
  calls: number;
  successes: number;
  failures: number;
  totalDurationMs: number;
}

/**
 * Canary rollout state
 */
interface CanaryState {
  enabled: boolean;
  trafficPercentage: number;
  startTime: Date;
  sessionAffinity: boolean;
  sessionMapping: Map<string, ProviderApiVersion>;
  errorRate: number;
  maxErrorRate: number;
}

/**
 * Version-aware provider loader
 */
export class VersionedProviderLoader {
  private routers: Map<string, VersionRouter> = new Map();
  private providers: Map<string, Map<ProviderApiVersion, unknown>> = new Map();
  private adapter: CompatibilityAdapter;
  private factory: VersionAdapterFactory;

  constructor(
    adapter: CompatibilityAdapter,
    factory: VersionAdapterFactory
  ) {
    this.adapter = adapter;
    this.factory = factory;
  }

  /**
   * Register a provider version
   */
  registerProviderVersion(
    provider: string,
    version: ProviderApiVersion,
    instance: unknown
  ): void {
    if (!this.providers.has(provider)) {
      this.providers.set(provider, new Map());
    }

    this.providers.get(provider)!.set(version, instance);
    logger.info(`Registered ${provider} version ${version}`);
  }

  /**
   * Register a routing configuration for a provider
   */
  registerRoutingConfig(
    provider: string,
    config: ProviderVersionRoutingConfig
  ): void {
    const router = new VersionRouter(config, this.adapter, this.factory);
    this.routers.set(provider, router);
    logger.info(`Registered routing config for ${provider}: strategy=${config.strategy}`);
  }

  /**
   * Get the appropriate provider version for a transaction
   */
  async resolveProvider(
    provider: string,
    context: TransactionContext
  ): Promise<{ instance: unknown; version: ProviderApiVersion }> {
    const router = this.routers.get(provider);
    if (!router) {
      throw new Error(`No routing config found for provider: ${provider}`);
    }

    const selection = router.selectVersion(context);
    const instance = this.providers.get(provider)?.get(selection.version);

    if (!instance) {
      throw new Error(
        `No instance found for ${provider} version ${selection.version}`
      );
    }

    logger.debug(
      `Resolved ${provider} to version ${selection.version} (${selection.reason})`
    );

    return {
      instance,
      version: selection.version,
    };
  }

  /**
   * Get router for a provider
   */
  getRouter(provider: string): VersionRouter | undefined {
    return this.routers.get(provider);
  }

  /**
   * Execute operation with automatic fallback
   */
  async executeWithFallback<T>(
    provider: string,
    context: TransactionContext,
    operation: (instance: unknown, version: ProviderApiVersion) => Promise<T>
  ): Promise<VersionedOperationResult> {
    const router = this.routers.get(provider);
    if (!router) {
      throw new Error(`No routing config for ${provider}`);
    }

    const startTime = Date.now();
    const primarySelection = router.selectVersion(context);

    try {
      const primaryInstance = this.providers
        .get(provider)
        ?.get(primarySelection.version);

      if (!primaryInstance) {
        throw new Error(
          `No instance for ${provider} version ${primarySelection.version}`
        );
      }

      const result = await operation(primaryInstance, primarySelection.version);

      const durationMs = Date.now() - startTime;
      router.recordPerformance(primarySelection.version, true, durationMs);

      return {
        success: true,
        data: result,
        apiVersion: primarySelection.version,
        executionTimeMs: durationMs,
        retried: false,
        fallbackUsed: false,
      };
    } catch (error) {
      logger.warn(
        `Operation failed with ${provider} version ${primarySelection.version}:`,
        error
      );

      // Try secondary version
      if (context.metadata?.allowFallback !== false) {
        return this.executeWithSecondaryVersion(
          provider,
          context,
          operation,
          primarySelection.version,
          startTime,
          error
        );
      }

      const durationMs = Date.now() - startTime;
      router.recordPerformance(primarySelection.version, false, durationMs);

      return {
        success: false,
        error,
        apiVersion: primarySelection.version,
        executionTimeMs: durationMs,
        retried: false,
        fallbackUsed: false,
      };
    }
  }

  /**
   * Execute with secondary version
   */
  private async executeWithSecondaryVersion<T>(
    provider: string,
    context: TransactionContext,
    operation: (instance: unknown, version: ProviderApiVersion) => Promise<T>,
    primaryVersion: ProviderApiVersion,
    startTime: number,
    primaryError: unknown
  ): Promise<VersionedOperationResult> {
    const router = this.routers.get(provider);
    if (!router) {
      throw new Error(`No routing config for ${provider}`);
    }

    const config = router["config"] as ProviderVersionRoutingConfig;
    const secondaryVersion = config.secondaryVersion;

    if (!secondaryVersion || secondaryVersion === primaryVersion) {
      const durationMs = Date.now() - startTime;
      router.recordPerformance(primaryVersion, false, durationMs);

      return {
        success: false,
        error: primaryError,
        apiVersion: primaryVersion,
        executionTimeMs: durationMs,
        retried: true,
        fallbackUsed: false,
      };
    }

    try {
      const secondaryInstance = this.providers
        .get(provider)
        ?.get(secondaryVersion);

      if (!secondaryInstance) {
        throw new Error(
          `No instance for ${provider} version ${secondaryVersion}`
        );
      }

      logger.info(
        `Falling back to ${provider} version ${secondaryVersion}`
      );

      const result = await operation(secondaryInstance, secondaryVersion);
      const durationMs = Date.now() - startTime;

      router.recordPerformance(secondaryVersion, true, durationMs);
      router.recordPerformance(primaryVersion, false, Date.now() - startTime + durationMs);

      return {
        success: true,
        data: result,
        apiVersion: secondaryVersion,
        executionTimeMs: durationMs,
        retried: true,
        fallbackUsed: true,
      };
    } catch (fallbackError) {
      logger.error(
        `Fallback to ${provider} version ${secondaryVersion} also failed:`,
        fallbackError
      );

      const durationMs = Date.now() - startTime;
      router.recordPerformance(secondaryVersion, false, durationMs);

      return {
        success: false,
        error: new Error(
          `Both ${primaryVersion} and ${secondaryVersion} failed: ${fallbackError}`
        ),
        apiVersion: secondaryVersion,
        executionTimeMs: durationMs,
        retried: true,
        fallbackUsed: true,
      };
    }
  }
}
