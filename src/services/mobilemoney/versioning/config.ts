/**
 * Version Configuration Schema and Loader
 *
 * Extends the centralized appConfig with provider API versioning configuration.
 */

import convict from "convict";
import {
  ProviderApiVersion,
  VersionRoutingStrategy,
  ProviderVersionRoutingConfig,
  ProviderVersionConfig,
  RetryPolicy,
  CircuitBreakerConfig,
  VersionedProviderConfig,
} from "./types";

/**
 * Parse provider version enum
 */
function parseProviderApiVersion(val: unknown): ProviderApiVersion {
  const allowed = Object.values(ProviderApiVersion);
  if (!allowed.includes(val as ProviderApiVersion)) {
    throw new Error(
      `Invalid provider API version: ${val}. Allowed: ${allowed.join(", ")}`
    );
  }
  return val as ProviderApiVersion;
}

/**
 * Parse routing strategy enum
 */
function parseRoutingStrategy(val: unknown): VersionRoutingStrategy {
  const allowed = Object.values(VersionRoutingStrategy);
  if (!allowed.includes(val as VersionRoutingStrategy)) {
    throw new Error(
      `Invalid routing strategy: ${val}. Allowed: ${allowed.join(", ")}`
    );
  }
  return val as VersionRoutingStrategy;
}

/**
 * Version configuration schema extension
 */
export const versionConfigSchema = {
  // Provider API Versioning
  providerVersioning: {
    enabled: {
      doc: "Enable provider API versioning and compatibility layer",
      format: Boolean,
      default: false,
      env: "PROVIDER_VERSIONING_ENABLED",
    },
    enableMetrics: {
      doc: "Enable version migration metrics collection",
      format: Boolean,
      default: true,
      env: "PROVIDER_VERSIONING_METRICS_ENABLED",
    },
    enableLogging: {
      doc: "Enable verbose version routing logging",
      format: Boolean,
      default: false,
      env: "PROVIDER_VERSIONING_LOGGING_ENABLED",
    },
    defaultStrategy: {
      doc: "Default version routing strategy",
      format: parseRoutingStrategy,
      default: VersionRoutingStrategy.FIXED,
      env: "PROVIDER_DEFAULT_ROUTING_STRATEGY",
    },
  },

  // MTN versioning
  mtnVersioning: {
    enabledVersions: {
      doc: "Comma-separated list of enabled MTN API versions",
      format: String,
      default: "v1,v2",
      env: "MTN_ENABLED_VERSIONS",
    },
    defaultVersion: {
      doc: "Default MTN API version",
      format: parseProviderApiVersion,
      default: ProviderApiVersion.V1,
      env: "MTN_DEFAULT_VERSION",
    },
    strategy: {
      doc: "MTN version routing strategy",
      format: parseRoutingStrategy,
      default: VersionRoutingStrategy.FIXED,
      env: "MTN_ROUTING_STRATEGY",
    },
    primaryVersion: {
      doc: "MTN primary API version (for failover)",
      format: parseProviderApiVersion,
      default: ProviderApiVersion.V1,
      env: "MTN_PRIMARY_VERSION",
    },
    secondaryVersion: {
      doc: "MTN secondary API version (for failover)",
      format: parseProviderApiVersion,
      default: ProviderApiVersion.V2,
      env: "MTN_SECONDARY_VERSION",
    },
    v1BaseUrl: {
      doc: "MTN API v1 base URL",
      format: String,
      default: "https://api.mtn.com/v1",
      env: "MTN_V1_BASE_URL",
    },
    v2BaseUrl: {
      doc: "MTN API v2 base URL",
      format: String,
      default: "https://api.mtn.com/v2",
      env: "MTN_V2_BASE_URL",
    },
    canaryTrafficPercentage: {
      doc: "Percentage of MTN traffic for canary rollout (0-100)",
      format: "nat",
      default: 0,
      env: "MTN_CANARY_TRAFFIC_PERCENTAGE",
    },
    canaryMaxErrorRate: {
      doc: "Maximum error rate for MTN canary (0-1)",
      format: Number,
      default: 0.05,
      env: "MTN_CANARY_MAX_ERROR_RATE",
    },
    v1Timeout: {
      doc: "MTN v1 API timeout in milliseconds",
      format: "nat",
      default: 30000,
      env: "MTN_V1_TIMEOUT",
    },
    v2Timeout: {
      doc: "MTN v2 API timeout in milliseconds",
      format: "nat",
      default: 20000,
      env: "MTN_V2_TIMEOUT",
    },
  },

  // Airtel versioning
  airtelVersioning: {
    enabledVersions: {
      doc: "Comma-separated list of enabled Airtel API versions",
      format: String,
      default: "v1,v2",
      env: "AIRTEL_ENABLED_VERSIONS",
    },
    defaultVersion: {
      doc: "Default Airtel API version",
      format: parseProviderApiVersion,
      default: ProviderApiVersion.V1,
      env: "AIRTEL_DEFAULT_VERSION",
    },
    strategy: {
      doc: "Airtel version routing strategy",
      format: parseRoutingStrategy,
      default: VersionRoutingStrategy.FIXED,
      env: "AIRTEL_ROUTING_STRATEGY",
    },
    primaryVersion: {
      doc: "Airtel primary API version (for failover)",
      format: parseProviderApiVersion,
      default: ProviderApiVersion.V1,
      env: "AIRTEL_PRIMARY_VERSION",
    },
    secondaryVersion: {
      doc: "Airtel secondary API version (for failover)",
      format: parseProviderApiVersion,
      default: ProviderApiVersion.V2,
      env: "AIRTEL_SECONDARY_VERSION",
    },
    v1BaseUrl: {
      doc: "Airtel API v1 base URL",
      format: String,
      default: "https://api.airtel.com/v1",
      env: "AIRTEL_V1_BASE_URL",
    },
    v2BaseUrl: {
      doc: "Airtel API v2 base URL",
      format: String,
      default: "https://api.airtel.com/v2",
      env: "AIRTEL_V2_BASE_URL",
    },
    canaryTrafficPercentage: {
      doc: "Percentage of Airtel traffic for canary rollout (0-100)",
      format: "nat",
      default: 0,
      env: "AIRTEL_CANARY_TRAFFIC_PERCENTAGE",
    },
    canaryMaxErrorRate: {
      doc: "Maximum error rate for Airtel canary (0-1)",
      format: Number,
      default: 0.05,
      env: "AIRTEL_CANARY_MAX_ERROR_RATE",
    },
    v1Timeout: {
      doc: "Airtel v1 API timeout in milliseconds",
      format: "nat",
      default: 30000,
      env: "AIRTEL_V1_TIMEOUT",
    },
    v2Timeout: {
      doc: "Airtel v2 API timeout in milliseconds",
      format: "nat",
      default: 20000,
      env: "AIRTEL_V2_TIMEOUT",
    },
  },

  // Orange versioning
  orangeVersioning: {
    enabledVersions: {
      doc: "Comma-separated list of enabled Orange API versions",
      format: String,
      default: "v1,v2",
      env: "ORANGE_ENABLED_VERSIONS",
    },
    defaultVersion: {
      doc: "Default Orange API version",
      format: parseProviderApiVersion,
      default: ProviderApiVersion.V1,
      env: "ORANGE_DEFAULT_VERSION",
    },
    strategy: {
      doc: "Orange version routing strategy",
      format: parseRoutingStrategy,
      default: VersionRoutingStrategy.FIXED,
      env: "ORANGE_ROUTING_STRATEGY",
    },
    primaryVersion: {
      doc: "Orange primary API version (for failover)",
      format: parseProviderApiVersion,
      default: ProviderApiVersion.V1,
      env: "ORANGE_PRIMARY_VERSION",
    },
    secondaryVersion: {
      doc: "Orange secondary API version (for failover)",
      format: parseProviderApiVersion,
      default: ProviderApiVersion.V2,
      env: "ORANGE_SECONDARY_VERSION",
    },
    v1BaseUrl: {
      doc: "Orange API v1 base URL",
      format: String,
      default: "https://api.orange.com/v1",
      env: "ORANGE_V1_BASE_URL",
    },
    v2BaseUrl: {
      doc: "Orange API v2 base URL",
      format: String,
      default: "https://api.orange.com/v2",
      env: "ORANGE_V2_BASE_URL",
    },
    canaryTrafficPercentage: {
      doc: "Percentage of Orange traffic for canary rollout (0-100)",
      format: "nat",
      default: 0,
      env: "ORANGE_CANARY_TRAFFIC_PERCENTAGE",
    },
    canaryMaxErrorRate: {
      doc: "Maximum error rate for Orange canary (0-1)",
      format: Number,
      default: 0.05,
      env: "ORANGE_CANARY_MAX_ERROR_RATE",
    },
    v1Timeout: {
      doc: "Orange v1 API timeout in milliseconds",
      format: "nat",
      default: 30000,
      env: "ORANGE_V1_TIMEOUT",
    },
    v2Timeout: {
      doc: "Orange v2 API timeout in milliseconds",
      format: "nat",
      default: 20000,
      env: "ORANGE_V2_TIMEOUT",
    },
  },
};

/**
 * Helper to parse versioning config from environment
 */
export function parseVersionConfig(config: Record<string, unknown>): Partial<VersionedProviderConfig> {
  const versioningEnabled = config.providerVersioning?.enabled ?? false;

  if (!versioningEnabled) {
    return { providers: {} };
  }

  return {
    enableMetrics: config.providerVersioning?.enableMetrics ?? true,
    enableLogging: config.providerVersioning?.enableLogging ?? false,
    providers: {
      mtn: buildProviderVersionConfig(
        "mtn",
        config.mtnVersioning as Record<string, unknown>
      ),
      airtel: buildProviderVersionConfig(
        "airtel",
        config.airtelVersioning as Record<string, unknown>
      ),
      orange: buildProviderVersionConfig(
        "orange",
        config.orangeVersioning as Record<string, unknown>
      ),
    },
  };
}

/**
 * Build version configuration for a specific provider
 */
function buildProviderVersionConfig(
  providerName: string,
  config: Record<string, unknown>
): {
  versions: { [key in ProviderApiVersion]?: ProviderVersionConfig };
  routing: ProviderVersionRoutingConfig;
} {
  const enabledVersions = (config.enabledVersions as string)?.split(",") ?? [];
  const primaryVersion = config.primaryVersion as ProviderApiVersion;
  const secondaryVersion = config.secondaryVersion as ProviderApiVersion;

  const versions: { [key in ProviderApiVersion]?: ProviderVersionConfig } = {};

  if (enabledVersions.includes("v1")) {
    versions[ProviderApiVersion.V1] = {
      version: ProviderApiVersion.V1,
      enabled: true,
      baseUrl: config[`v1BaseUrl`] as string,
      endpoints: buildVersionEndpoints(ProviderApiVersion.V1),
      timeout: config[`v1Timeout`] as number,
    };
  }

  if (enabledVersions.includes("v2")) {
    versions[ProviderApiVersion.V2] = {
      version: ProviderApiVersion.V2,
      enabled: true,
      baseUrl: config[`v2BaseUrl`] as string,
      endpoints: buildVersionEndpoints(ProviderApiVersion.V2),
      timeout: config[`v2Timeout`] as number,
    };
  }

  return {
    versions,
    routing: {
      provider: providerName,
      strategy: config.strategy as VersionRoutingStrategy,
      primaryVersion,
      secondaryVersion,
      canaryConfig: {
        trafficPercentage: config.canaryTrafficPercentage as number,
        maxErrorRate: config.canaryMaxErrorRate as number,
      },
    },
  };
}

/**
 * Build standard endpoints for a version
 * In production, this would be tailored per provider/version
 */
function buildVersionEndpoints(version: ProviderApiVersion) {
  const base = version === ProviderApiVersion.V1 ? "/collection" : "/transfers";

  return {
    requestPayment: `${base}/request`,
    sendPayout: `${base}/payout`,
    getTransactionStatus: `${base}/status`,
    sendBatchPayout: `${base}/batch-payout`,
    getBalance: `${base}/balance`,
  };
}
