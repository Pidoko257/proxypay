/**
 * Provider API Versioning Module
 *
 * Exports all versioning, compatibility, and routing utilities
 * for managing multi-version provider API migrations.
 */

// Types
export {
  ProviderApiVersion,
  VersionRoutingStrategy,
  CompatibilityLevel,
  ProviderVersionConfig,
  VersionEndpoints,
  RetryPolicy,
  CircuitBreakerConfig,
  ProviderVersionRoutingConfig,
  CanaryConfig,
  ConditionalRoutingRule,
  TransactionContext,
  CompatibilityMapping,
  MigrationProgress,
  MigrationMetrics,
  VersionedOperationResult,
  VersionedProviderConfig,
} from "./types";

// Configuration
export {
  versionConfigSchema,
  parseVersionConfig,
} from "./config";

// Adapters & Factories
export {
  CompatibilityAdapter,
  VersionAdapterFactory,
  getGlobalCompatibilityAdapter,
  getGlobalVersionAdapterFactory,
} from "./adapter";

// Routing & Loading
export {
  VersionRouter,
  VersionedProviderLoader,
} from "./loader";

// Provider-Specific Bridges
export {
  MTNCompatibilityBridge,
  AirtelCompatibilityBridge,
  OrangeCompatibilityBridge,
  registerAllCompatibilityBridges,
} from "./bridges";
