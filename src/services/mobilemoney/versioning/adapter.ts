/**
 * Version Compatibility Layer and Adapter Factory
 *
 * Provides adapters for bridging different API versions and transforming
 * requests/responses between versions.
 */

import {
  ProviderApiVersion,
  CompatibilityMapping,
  CompatibilityLevel,
  TransactionContext,
  VersionedOperationResult,
} from "./types";
import logger from "../../../utils/logger";

/**
 * Compatibility adapter for transforming between API versions
 */
export class CompatibilityAdapter {
  private mappings: Map<string, CompatibilityMapping> = new Map();
  private compatibilityCache: Map<string, CompatibilityLevel> = new Map();

  constructor() {
    this.initializeMappings();
  }

  /**
   * Initialize default compatibility mappings
   */
  private initializeMappings(): void {
    // V1 -> V2 mapping
    this.registerMapping({
      sourceVersion: ProviderApiVersion.V1,
      targetVersion: ProviderApiVersion.V2,
      requestMapper: this.mapRequestV1ToV2.bind(this),
      responseMapper: this.mapResponseV2ToV1.bind(this),
    });

    // V2 -> V1 mapping (fallback)
    this.registerMapping({
      sourceVersion: ProviderApiVersion.V2,
      targetVersion: ProviderApiVersion.V1,
      requestMapper: this.mapRequestV2ToV1.bind(this),
      responseMapper: this.mapResponseV1ToV2.bind(this),
    });
  }

  /**
   * Register a custom compatibility mapping
   */
  registerMapping(mapping: CompatibilityMapping): void {
    const key = `${mapping.sourceVersion}_to_${mapping.targetVersion}`;
    this.mappings.set(key, mapping);
    // Clear cache when mapping changes
    this.compatibilityCache.clear();
    logger.info(
      `Registered compatibility mapping: ${mapping.sourceVersion} -> ${mapping.targetVersion}`
    );
  }

  /**
   * Transform request from source version to target version
   */
  transformRequest(
    request: unknown,
    sourceVersion: ProviderApiVersion,
    targetVersion: ProviderApiVersion
  ): unknown {
    if (sourceVersion === targetVersion) {
      return request;
    }

    const key = `${sourceVersion}_to_${targetVersion}`;
    const mapping = this.mappings.get(key);

    if (!mapping) {
      logger.warn(
        `No mapping found for ${sourceVersion} -> ${targetVersion}, returning request as-is`
      );
      return request;
    }

    try {
      return mapping.requestMapper(request);
    } catch (error) {
      logger.error(
        `Error transforming request from ${sourceVersion} to ${targetVersion}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Transform response from target version back to source version format
   */
  transformResponse(
    response: unknown,
    sourceVersion: ProviderApiVersion,
    targetVersion: ProviderApiVersion
  ): unknown {
    if (sourceVersion === targetVersion) {
      return response;
    }

    const key = `${sourceVersion}_to_${targetVersion}`;
    const mapping = this.mappings.get(key);

    if (!mapping) {
      logger.warn(
        `No mapping found for ${sourceVersion} -> ${targetVersion}, returning response as-is`
      );
      return response;
    }

    try {
      return mapping.responseMapper(response);
    } catch (error) {
      logger.error(
        `Error transforming response from ${targetVersion} to ${sourceVersion}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Get compatibility level between versions
   */
  getCompatibilityLevel(
    sourceVersion: ProviderApiVersion,
    targetVersion: ProviderApiVersion
  ): CompatibilityLevel {
    if (sourceVersion === targetVersion) {
      return CompatibilityLevel.FULL;
    }

    const cacheKey = `${sourceVersion}_to_${targetVersion}`;
    if (this.compatibilityCache.has(cacheKey)) {
      return this.compatibilityCache.get(cacheKey)!;
    }

    const mapping = this.mappings.get(cacheKey);
    const level = mapping ? CompatibilityLevel.COMPATIBLE : CompatibilityLevel.UNSUPPORTED;

    this.compatibilityCache.set(cacheKey, level);
    return level;
  }

  /**
   * Check if a feature is supported in the target version
   */
  isFeatureSupported(
    feature: string,
    targetVersion: ProviderApiVersion
  ): boolean {
    // Extended features only in V2+
    const v2Features = ["batch_operations", "webhooks", "async_status"];
    if (targetVersion === ProviderApiVersion.V1) {
      return !v2Features.includes(feature);
    }
    return true;
  }

  /**
   * Map V1 request to V2 format
   */
  private mapRequestV1ToV2(request: unknown): unknown {
    if (typeof request !== "object" || request === null) {
      return request;
    }

    const v1Req = request as Record<string, unknown>;

    // V1 uses snake_case, V2 uses camelCase
    return {
      phoneNumber: v1Req.phone_number,
      amount: v1Req.amount,
      currency: v1Req.currency || "XAF",
      externalId: v1Req.external_id,
      description: v1Req.description,
      callbackUrl: v1Req.callback_url,
      metadata: v1Req.metadata,
    };
  }

  /**
   * Map V2 response back to V1 format
   */
  private mapResponseV2ToV1(response: unknown): unknown {
    if (typeof response !== "object" || response === null) {
      return response;
    }

    const v2Res = response as Record<string, unknown>;

    // V2 uses camelCase, V1 uses snake_case
    return {
      transaction_id: v2Res.transactionId,
      external_id: v2Res.externalId,
      status: v2Res.status,
      amount: v2Res.amount,
      currency: v2Res.currency,
      timestamp: v2Res.timestamp,
      error_message: v2Res.errorMessage,
    };
  }

  /**
   * Map V2 request to V1 format
   */
  private mapRequestV2ToV1(request: unknown): unknown {
    if (typeof request !== "object" || request === null) {
      return request;
    }

    const v2Req = request as Record<string, unknown>;

    // V2 uses camelCase, V1 uses snake_case
    return {
      phone_number: v2Req.phoneNumber,
      amount: v2Req.amount,
      currency: v2Req.currency || "XAF",
      external_id: v2Req.externalId,
      description: v2Req.description,
      callback_url: v2Req.callbackUrl,
      metadata: v2Req.metadata,
    };
  }

  /**
   * Map V1 response back to V2 format
   */
  private mapResponseV1ToV2(response: unknown): unknown {
    if (typeof response !== "object" || response === null) {
      return response;
    }

    const v1Res = response as Record<string, unknown>;

    // V1 uses snake_case, V2 uses camelCase
    return {
      transactionId: v1Res.transaction_id,
      externalId: v1Res.external_id,
      status: v1Res.status,
      amount: v1Res.amount,
      currency: v1Res.currency,
      timestamp: v1Res.timestamp,
      errorMessage: v1Res.error_message,
    };
  }
}

/**
 * Version adapter factory for creating versioned provider wrappers
 */
export class VersionAdapterFactory {
  private adapter: CompatibilityAdapter;
  private executionMetrics: Map<string, ExecutionMetrics> = new Map();

  constructor(compatibilityAdapter?: CompatibilityAdapter) {
    this.adapter = compatibilityAdapter || new CompatibilityAdapter();
  }

  /**
   * Wrap a provider with version adaptation
   */
  wrapProvider<T extends Record<string, unknown>>(
    provider: T,
    sourceVersion: ProviderApiVersion,
    targetVersion: ProviderApiVersion
  ): T {
    if (sourceVersion === targetVersion) {
      return provider;
    }

    // Create proxy to intercept method calls
    return new Proxy(provider, {
      apply: (target, thisArg, args) => {
        if (typeof target === "function") {
          return this.executeWithTransform(
            target as Function,
            args,
            sourceVersion,
            targetVersion
          );
        }
        return Reflect.apply(target as Function, thisArg, args);
      },
    }) as T;
  }

  /**
   * Execute a provider method with request/response transformation
   */
  async executeWithTransform(
    method: Function,
    args: unknown[],
    sourceVersion: ProviderApiVersion,
    targetVersion: ProviderApiVersion
  ): Promise<unknown> {
    const startTime = Date.now();
    const metricsKey = `${method.name}_${sourceVersion}_to_${targetVersion}`;

    try {
      // Transform request
      const transformedArgs = args.map((arg) =>
        this.adapter.transformRequest(arg, sourceVersion, targetVersion)
      );

      // Execute method
      const result = await method.apply(null, transformedArgs);

      // Transform response
      const transformedResult = this.adapter.transformResponse(
        result,
        sourceVersion,
        targetVersion
      );

      this.recordMetric(metricsKey, Date.now() - startTime, true);
      return transformedResult;
    } catch (error) {
      this.recordMetric(metricsKey, Date.now() - startTime, false, error);
      throw error;
    }
  }

  /**
   * Record execution metrics for a transformation
   */
  private recordMetric(
    key: string,
    durationMs: number,
    success: boolean,
    error?: unknown
  ): void {
    const metrics = this.executionMetrics.get(key) || {
      calls: 0,
      successes: 0,
      failures: 0,
      totalDurationMs: 0,
      lastError: null,
    };

    metrics.calls++;
    metrics.totalDurationMs += durationMs;

    if (success) {
      metrics.successes++;
    } else {
      metrics.failures++;
      metrics.lastError = error instanceof Error ? error.message : String(error);
    }

    this.executionMetrics.set(key, metrics);
  }

  /**
   * Get execution metrics for a transformation
   */
  getMetrics(key?: string): Record<string, ExecutionMetrics> {
    if (key) {
      return { [key]: this.executionMetrics.get(key) || this.emptyMetrics() };
    }
    return Object.fromEntries(this.executionMetrics);
  }

  /**
   * Get average latency for a transformation
   */
  getAverageLatency(key: string): number {
    const metrics = this.executionMetrics.get(key);
    if (!metrics || metrics.calls === 0) {
      return 0;
    }
    return metrics.totalDurationMs / metrics.calls;
  }

  /**
   * Reset metrics
   */
  resetMetrics(): void {
    this.executionMetrics.clear();
  }

  private emptyMetrics(): ExecutionMetrics {
    return {
      calls: 0,
      successes: 0,
      failures: 0,
      totalDurationMs: 0,
      lastError: null,
    };
  }
}

/**
 * Execution metrics for tracking performance
 */
interface ExecutionMetrics {
  calls: number;
  successes: number;
  failures: number;
  totalDurationMs: number;
  lastError: string | null;
}

/**
 * Global compatibility adapter instance
 */
let globalAdapter: CompatibilityAdapter | null = null;

/**
 * Get or create global compatibility adapter
 */
export function getGlobalCompatibilityAdapter(): CompatibilityAdapter {
  if (!globalAdapter) {
    globalAdapter = new CompatibilityAdapter();
  }
  return globalAdapter;
}

/**
 * Get or create global version adapter factory
 */
export function getGlobalVersionAdapterFactory(): VersionAdapterFactory {
  return new VersionAdapterFactory(getGlobalCompatibilityAdapter());
}
