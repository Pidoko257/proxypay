/**
 * Migration Strategy Configuration for Provider API Versions
 *
 * Provides pre-built strategies and helpers for managing gradual provider
 * API version migrations in production environments.
 */

import {
  ProviderApiVersion,
  VersionRoutingStrategy,
  ProviderVersionRoutingConfig,
  CanaryConfig,
  ConditionalRoutingRule,
  TransactionContext,
  MigrationProgress,
  MigrationMetrics,
} from "./types";
import logger from "../../../utils/logger";

/**
 * Pre-built migration phases for structured rollout
 */
export enum MigrationPhase {
  PLANNING = "planning",
  INTERNAL_TESTING = "internal_testing",
  EARLY_ADOPTERS = "early_adopters",
  CANARY_ROLLOUT = "canary_rollout",
  GRADUAL_EXPANSION = "gradual_expansion",
  COMPLETE = "complete",
  ROLLED_BACK = "rolled_back",
}

/**
 * Defines a migration phase with associated routing strategy
 */
export interface MigrationPhaseConfig {
  phase: MigrationPhase;
  strategy: VersionRoutingStrategy;
  canaryTraffic?: number; // 0-100
  conditionalRules?: ConditionalRoutingRule[];
  duration?: number; // milliseconds
  description: string;
}

/**
 * Complete migration plan from V1 to V2
 */
export interface MigrationPlan {
  provider: string;
  sourceVersion: ProviderApiVersion;
  targetVersion: ProviderApiVersion;
  phases: MigrationPhaseConfig[];
  startDate: Date;
  estimatedCompletionDate: Date;
  rollbackThreshold: number; // Error rate threshold for automatic rollback (0-1)
}

/**
 * Pre-built migration plans for common scenarios
 */
export class MigrationStrategies {
  /**
   * Conservative rollout: Start with canary at 1%, gradually increase
   * Typical duration: 2-4 weeks
   */
  static conservativeRollout(
    provider: string,
    targetVersion: ProviderApiVersion
  ): MigrationPlan {
    return {
      provider,
      sourceVersion: ProviderApiVersion.V1,
      targetVersion,
      phases: [
        {
          phase: MigrationPhase.PLANNING,
          strategy: VersionRoutingStrategy.FIXED,
          description: "Validate configuration and test compatibility",
        },
        {
          phase: MigrationPhase.INTERNAL_TESTING,
          strategy: VersionRoutingStrategy.FIXED,
          canaryTraffic: 100,
          description: "Route all internal transactions to V2",
        },
        {
          phase: MigrationPhase.EARLY_ADOPTERS,
          strategy: VersionRoutingStrategy.CONDITIONAL,
          conditionalRules: [
            {
              condition: (ctx) => this.isEarlyAdopterUser(ctx),
              version: targetVersion,
              priority: 100,
            },
          ],
          description: "Route early adopter users to V2",
        },
        {
          phase: MigrationPhase.CANARY_ROLLOUT,
          strategy: VersionRoutingStrategy.CANARY,
          canaryTraffic: 5,
          description: "Start canary at 5% of production traffic",
        },
        {
          phase: MigrationPhase.GRADUAL_EXPANSION,
          strategy: VersionRoutingStrategy.CANARY,
          canaryTraffic: 50,
          description: "Expand to 50% of production traffic",
        },
        {
          phase: MigrationPhase.COMPLETE,
          strategy: VersionRoutingStrategy.FIXED,
          description: "Switch all traffic to V2",
        },
      ],
      startDate: new Date(),
      estimatedCompletionDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      rollbackThreshold: 0.05, // Rollback if error rate exceeds 5%
    };
  }

  /**
   * Aggressive rollout: Fast migration with minimal testing window
   * Typical duration: 3-5 days
   */
  static aggressiveRollout(
    provider: string,
    targetVersion: ProviderApiVersion
  ): MigrationPlan {
    return {
      provider,
      sourceVersion: ProviderApiVersion.V1,
      targetVersion,
      phases: [
        {
          phase: MigrationPhase.PLANNING,
          strategy: VersionRoutingStrategy.FIXED,
          description: "Quick validation and compatibility check",
        },
        {
          phase: MigrationPhase.CANARY_ROLLOUT,
          strategy: VersionRoutingStrategy.CANARY,
          canaryTraffic: 25,
          description: "Start with 25% canary",
        },
        {
          phase: MigrationPhase.GRADUAL_EXPANSION,
          strategy: VersionRoutingStrategy.CANARY,
          canaryTraffic: 100,
          description: "Ramp to 100%",
        },
        {
          phase: MigrationPhase.COMPLETE,
          strategy: VersionRoutingStrategy.FIXED,
          description: "Finalize migration",
        },
      ],
      startDate: new Date(),
      estimatedCompletionDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), // 5 days
      rollbackThreshold: 0.1, // More lenient: 10% error threshold
    };
  }

  /**
   * Shadow mode: Run V2 in parallel without affecting production traffic
   * Useful for validation before switchover
   */
  static shadowMode(
    provider: string,
    targetVersion: ProviderApiVersion
  ): MigrationPlan {
    return {
      provider,
      sourceVersion: ProviderApiVersion.V1,
      targetVersion,
      phases: [
        {
          phase: MigrationPhase.INTERNAL_TESTING,
          strategy: VersionRoutingStrategy.SHADOW,
          description: "Shadow V2 requests for 100% of production traffic",
        },
        {
          phase: MigrationPhase.CANARY_ROLLOUT,
          strategy: VersionRoutingStrategy.CANARY,
          canaryTraffic: 1,
          description: "After validation, start 1% real traffic",
        },
        {
          phase: MigrationPhase.COMPLETE,
          strategy: VersionRoutingStrategy.FIXED,
          description: "Full migration after shadow validation",
        },
      ],
      startDate: new Date(),
      estimatedCompletionDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 days
      rollbackThreshold: 0.02, // Very strict: 2% for shadow
    };
  }

  /**
   * Geographically-isolated rollout: Test new version in one region first
   */
  static geographicRollout(
    provider: string,
    targetVersion: ProviderApiVersion,
    testRegion: string
  ): MigrationPlan {
    return {
      provider,
      sourceVersion: ProviderApiVersion.V1,
      targetVersion,
      phases: [
        {
          phase: MigrationPhase.INTERNAL_TESTING,
          strategy: VersionRoutingStrategy.CONDITIONAL,
          conditionalRules: [
            {
              condition: (ctx) => this.isRegion(ctx, testRegion),
              version: targetVersion,
              priority: 100,
            },
          ],
          description: `Test V2 in ${testRegion} region only`,
        },
        {
          phase: MigrationPhase.CANARY_ROLLOUT,
          strategy: VersionRoutingStrategy.CANARY,
          canaryTraffic: 50,
          description: "Expand to other regions with 50% canary",
        },
        {
          phase: MigrationPhase.COMPLETE,
          strategy: VersionRoutingStrategy.FIXED,
          description: "Full global migration",
        },
      ],
      startDate: new Date(),
      estimatedCompletionDate: new Date(Date.now() + 21 * 24 * 60 * 60 * 1000), // 21 days
      rollbackThreshold: 0.05,
    };
  }

  /**
   * Helper: Check if user is an early adopter
   */
  private static isEarlyAdopterUser(ctx: TransactionContext): boolean {
    // In production, this would query a database or cache
    const earlyAdopterIds = process.env.EARLY_ADOPTER_USER_IDS?.split(",") || [];
    return earlyAdopterIds.includes(ctx.userId || "");
  }

  /**
   * Helper: Check if request is from a specific region
   */
  private static isRegion(ctx: TransactionContext, region: string): boolean {
    // In production, this would map phone number to region
    const regionPhone = process.env[`REGION_${region.toUpperCase()}_COUNTRY_CODE`];
    const phoneCountryCode = ctx.phoneNumber.substring(0, 3);
    return phoneCountryCode === regionPhone;
  }
}

/**
 * Migration progress tracker
 */
export class MigrationProgressTracker {
  private progress: MigrationProgress;
  private metricsCollectionInterval: NodeJS.Timer | null = null;

  constructor(
    provider: string,
    sourceVersion: ProviderApiVersion,
    targetVersion: ProviderApiVersion
  ) {
    this.progress = {
      provider,
      sourceVersion,
      targetVersion,
      startDate: new Date(),
      expectedCompletionDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      currentTrafficPercentage: 0,
      status: "planning",
      metrics: {
        totalTransactions: 0,
        successCount: 0,
        failureCount: 0,
        avgLatencyMs: 0,
        errorRate: 0,
        rollbackCount: 0,
        usersFailed: new Set(),
      },
    };
  }

  /**
   * Record a transaction attempt
   */
  recordTransaction(
    success: boolean,
    latencyMs: number,
    userId?: string,
    error?: Error
  ): void {
    this.progress.metrics.totalTransactions++;

    if (success) {
      this.progress.metrics.successCount++;
    } else {
      this.progress.metrics.failureCount++;
      if (userId) {
        this.progress.metrics.usersFailed.add(userId);
      }
    }

    // Update running average
    const totalLatency =
      this.progress.metrics.avgLatencyMs *
      (this.progress.metrics.totalTransactions - 1);
    this.progress.metrics.avgLatencyMs =
      (totalLatency + latencyMs) / this.progress.metrics.totalTransactions;

    this.progress.metrics.errorRate =
      this.progress.metrics.failureCount / this.progress.metrics.totalTransactions;

    // Log if error rate exceeds threshold
    if (this.progress.metrics.errorRate > 0.05) {
      logger.warn(
        `Migration error rate for ${this.progress.provider} exceeded 5%: ${(this.progress.metrics.errorRate * 100).toFixed(2)}%`
      );
    }
  }

  /**
   * Record rollback event
   */
  recordRollback(): void {
    this.progress.metrics.rollbackCount++;
    this.progress.status = "rolled_back";
    logger.error(
      `Rolled back migration for ${this.progress.provider}: ${this.progress.metrics.rollbackCount} rollback(s)`
    );
  }

  /**
   * Update migration phase
   */
  updatePhase(status: "planning" | "in_progress" | "completed" | "rolled_back"): void {
    this.progress.status = status;
    logger.info(
      `Migration phase updated for ${this.progress.provider}: ${status}`
    );
  }

  /**
   * Update canary traffic percentage
   */
  updateCanaryTraffic(percentage: number): void {
    this.progress.currentTrafficPercentage = Math.min(100, Math.max(0, percentage));
  }

  /**
   * Get current metrics
   */
  getMetrics(): MigrationMetrics {
    return {
      ...this.progress.metrics,
    };
  }

  /**
   * Get migration status report
   */
  getStatus(): MigrationProgress {
    return {
      ...this.progress,
      metrics: { ...this.progress.metrics },
    };
  }

  /**
   * Check if migration should be rolled back
   */
  shouldRollback(errorRateThreshold: number): boolean {
    return this.progress.metrics.errorRate > errorRateThreshold;
  }

  /**
   * Calculate estimated completion time
   */
  getEstimatedTimeToCompletion(): number {
    if (this.progress.currentTrafficPercentage >= 100) {
      return 0;
    }

    const now = new Date();
    const elapsedMs = now.getTime() - this.progress.startDate.getTime();
    const progressRate = this.progress.currentTrafficPercentage / 100;

    if (progressRate === 0) {
      return -1; // Not started
    }

    const estimatedTotalMs = elapsedMs / progressRate;
    const remainingMs = estimatedTotalMs - elapsedMs;

    return Math.max(0, remainingMs);
  }

  /**
   * Start automatic metrics collection
   */
  startMetricsCollection(intervalMs: number = 60000): void {
    this.metricsCollectionInterval = setInterval(() => {
      logger.info(`Migration metrics for ${this.progress.provider}:`, this.getMetrics());
    }, intervalMs);
  }

  /**
   * Stop metrics collection
   */
  stopMetricsCollection(): void {
    if (this.metricsCollectionInterval) {
      clearInterval(this.metricsCollectionInterval);
      this.metricsCollectionInterval = null;
    }
  }
}
