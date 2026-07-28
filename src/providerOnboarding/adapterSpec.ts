/**
 * Provider Adapter Specification
 *
 * Issue #187 — Provider Onboarding Workflow, acceptance criterion #1.
 *
 * This module defines the formal contract that every Mobile Money provider
 * implementation must satisfy to be onboarded into ProxyPay. It is fully
 * additive — it does NOT change or replace the runtime `MobileMoneyProvider`
 * interface in `src/services/mobilemoney/mobileMoneyService.ts`. Operators
 * can implement a `ProviderAdapter` against any backend (REST, OAuth2,
 * browser-session, proxy) and the onboarding tooling will treat it
 * uniformly.
 *
 * Operators who add a new provider are expected to:
 *   1. Implement a class conforming to `ProviderAdapter`
 *   2. Declare its `getCapabilities()` manifest
 *   3. Expose endpoints through `getEndpoints()`
 *   4. Register with `healthCheckSetup.registerProviderForHealthCheck()`
 *
 * Tests in __tests__/adapterSpec.test.ts pin the spec — providers that
 * deviate from the contract are rejected at runtime by `validateAdapter()`.
 */

// ─── Capability Model ───────────────────────────────────────────────────────

export type ProviderAuthMode = "direct" | "web" | "proxy" | "api_key" | "oauth";

export interface ProviderCapabilities {
  /** Can collect (request payment from) a customer's mobile wallet. */
  supportsPayment: boolean;
  /** Can disburse (send payout to) a customer's mobile wallet. */
  supportsPayout: boolean;
  /** Can submit multiple payouts in a single call (e.g. MTN B2B batch). */
  supportsBatchPayout: boolean;
  /** Can look up the status of an in-flight transaction by reference. */
  supportsStatusQuery: boolean;
  /** Can return the operational balance for the merchant account. */
  supportsBalance: boolean;
  /** Maximum items per batch payout (only meaningful when supportsBatchPayout). */
  maxBatchSize?: number;
  /** Authentication strategy — drives which credential fields are required. */
  authMode: ProviderAuthMode;
  /** ISO 4217 currency codes the provider supports (e.g. ["XAF", "EUR"]). */
  supportedCurrencies: string[];
  /** Default transaction currency used when the caller omits one. */
  defaultCurrency: string;
  /** Suggested monthly polling cadence in minutes (operator hint). */
  healthCheckIntervalMinutes?: number;
  /** Free-form notes printed by the onboarding wizard. */
  notes?: string[];
}

// ─── Endpoint Model ─────────────────────────────────────────────────────────

export interface ProviderEndpoints {
  /** Base URL for sandbox / test traffic. */
  sandbox: string;
  /** Base URL for production traffic. */
  production: string;
  /** URL used by the health check watchdog. Defaults to `sandbox`. */
  healthUrl?: string;
}

// ─── Environment Descriptor ─────────────────────────────────────────────────

export type ProviderEnvironment = "sandbox" | "production";

// ─── Credential Model ───────────────────────────────────────────────────────

/**
 * The cleartext shape of provider_credentials.encrypted_payload.
 * Stored encrypted in the provider_credentials table; decrypted in memory
 * only when the credentialManager hands a creds object to a provider.
 */
export interface ProviderCredentialPayload {
  /** Primary API key (direct & api_key modes). */
  apiKey?: string;
  /** Companion API secret (direct & api_key modes). */
  apiSecret?: string;
  /** MTN-style subscription key. */
  subscriptionKey?: string;
  /** OAuth2 client id (oauth mode). */
  clientId?: string;
  /** OAuth2 client secret (oauth mode). */
  clientSecret?: string;
  /** Web-portal username (web mode). */
  username?: string;
  /** Web-portal password (web mode). */
  password?: string;
  /** Shared secret used for webhook signature verification. */
  callbackSecret?: string;
  /** Free-form extras (e.g. proxy headers, MTN target environment). */
  extras?: Record<string, string>;
}

// ─── Adapter Contract ───────────────────────────────────────────────────────

export interface ProviderAdapter {
  /** Stable identifier (lowercase, snake-safe). e.g. "mtn", "vodacom". */
  readonly name: string;

  /** Display label shown in dashboards and CLI output. */
  readonly displayName: string;

  /** Endpoints per environment — the health check picks one. */
  getEndpoints(): ProviderEndpoints;

  /**
   * Static capability manifest. Returned synchronously so the onboarding
   * wizard can print the matrix without instantiating the provider.
   *
   * Live HTTP capability probing is intentionally NOT part of this contract
   * — see capabilityProbe.ts for the optional runtime probe path.
   */
  getCapabilities(): ProviderCapabilities;

  /** Returns the required credential fields for the current authMode. */
  getRequiredCredentialFields(): (keyof ProviderCredentialPayload)[];

  /**
   * Returns an in-memory Provider instance ready to dispatch calls.
   * Implementations should use the credentialManager to fetch secrets
   * so the actual key material never appears in provider source files.
   */
  instantiate(): ProviderAdapterInstance;
}

// ─── Instance surface (used after onboarding) ───────────────────────────────

export interface ProviderAdapterInstance {
  /** Request payment from a customer's wallet. */
  requestPayment(
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }>;

  /** Send a single payout to a customer's wallet. */
  sendPayout(
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }>;

  /** Optional: send many payouts in one call. */
  sendBatchPayout?(
    items: Array<{ referenceId: string; phoneNumber: string; amount: string }>,
    requestId?: string,
  ): Promise<{
    success: boolean;
    results: Array<{
      referenceId: string;
      success: boolean;
      error?: string;
      providerReference?: string;
    }>;
    error?: unknown;
  }>;

  /** Optional: status query for an in-flight reference. */
  getTransactionStatus?(
    referenceId: string,
  ): Promise<{
    status: "completed" | "failed" | "pending" | "unknown";
  }>;
}

// ─── Runtime validation ─────────────────────────────────────────────────────

export interface AdapterValidationError {
  field: string;
  message: string;
}

/**
 * Runtime validator: enforces the parts of the spec that cannot be enforced
 * by TypeScript alone. Throws an Error listing every violation, or returns
 * silently on a valid adapter.
 */
export function validateAdapter(adapter: ProviderAdapter): void {
  const errors: AdapterValidationError[] = [];

  if (!adapter.name || !/^[a-z][a-z0-9_-]{1,63}$/.test(adapter.name)) {
    errors.push({
      field: "name",
      message:
        "name must be lowercase, start with a letter, and contain [a-z0-9_-] only",
    });
  }

  if (!adapter.displayName || adapter.displayName.length < 2) {
    errors.push({
      field: "displayName",
      message: "displayName must be at least 2 characters",
    });
  }

  let endpoints: ProviderEndpoints;
  try {
    endpoints = adapter.getEndpoints();
    if (!endpoints.sandbox?.startsWith("http")) {
      errors.push({ field: "endpoints.sandbox", message: "must be an HTTPS URL" });
    }
    if (!endpoints.production?.startsWith("http")) {
      errors.push({ field: "endpoints.production", message: "must be an HTTPS URL" });
    }
  } catch (err) {
    errors.push({
      field: "endpoints",
      message: `getEndpoints() threw: ${(err as Error).message}`,
    });
    endpoints = { sandbox: "", production: "" };
  }

  let caps: ProviderCapabilities;
  try {
    caps = adapter.getCapabilities();
  } catch (err) {
    errors.push({
      field: "capabilities",
      message: `getCapabilities() threw: ${(err as Error).message}`,
    });
    caps = {
      supportsPayment: false,
      supportsPayout: false,
      supportsBatchPayout: false,
      supportsStatusQuery: false,
      supportsBalance: false,
      authMode: "direct",
      supportedCurrencies: [],
      defaultCurrency: "",
    };
  }

  const requiredByMode: Record<ProviderAuthMode, (keyof ProviderCredentialPayload)[]> = {
    direct: ["apiKey", "apiSecret"],
    api_key: ["apiKey", "apiSecret"],
    oauth: ["clientId", "clientSecret"],
    web: ["username", "password"],
    proxy: [],
  };

  // Cross-field sanity
  if (caps.supportedCurrencies.length === 0) {
    errors.push({
      field: "capabilities.supportedCurrencies",
      message: "must declare at least one supported currency",
    });
  }
  if (!caps.supportedCurrencies.includes(caps.defaultCurrency)) {
    errors.push({
      field: "capabilities.defaultCurrency",
      message: `defaultCurrency "${caps.defaultCurrency}" must appear in supportedCurrencies`,
    });
  }
  if (caps.supportsBatchPayout && (!caps.maxBatchSize || caps.maxBatchSize < 1)) {
    errors.push({
      field: "capabilities.maxBatchSize",
      message:
        "providers that support batch payouts must declare a positive maxBatchSize",
    });
  }

  // Required field set must include the default for the chosen authMode.
  // Errors intentionally bubble — a broken getRequiredCredentialFields
  // is a contract violation, not a silent fallback to "no required fields".
  if (typeof adapter.getRequiredCredentialFields !== "function") {
    errors.push({
      field: "getRequiredCredentialFields",
      message: "must be a function",
    });
  } else {
    const requiredFromAdapter: Set<keyof ProviderCredentialPayload> = new Set(
      adapter.getRequiredCredentialFields(),
    );
    const requiredFromMode = requiredByMode[caps.authMode] ?? [];
    for (const field of requiredFromMode) {
      if (!requiredFromAdapter.has(field)) {
        errors.push({
          field: `getRequiredCredentialFields()[${String(field)}]`,
          message: `authMode "${caps.authMode}" requires field "${String(field)}" to be listed`,
        });
      }
    }
  }

  // Surface canonical endpoints for the linter (no-op; kept for future
  // cross-field rules in the spec).
  void endpoints;

  if (errors.length > 0) {
    const lines = errors.map((e) => `  - [${e.field}] ${e.message}`).join("\n");
    throw new Error(
      `ProviderAdapter for "${adapter.name}" failed validation:\n${lines}`,
    );
  }
}

// ─── Built-in adapter registry ──────────────────────────────────────────────

/**
 * Registry of adapters that ship with ProxyPay. Onboarding a new provider
 * beyond this list means implementing ProviderAdapter and pushing to this
 * registry from the wizard's generated boilerplate.
 */
const BUILTIN_ADAPTERS: ProviderAdapter[] = [];

export function registerBuiltinAdapter(adapter: ProviderAdapter): void {
  validateAdapter(adapter);
  // Replace by name if it already exists so re-registration is idempotent.
  const idx = BUILTIN_ADAPTERS.findIndex((a) => a.name === adapter.name);
  if (idx >= 0) {
    BUILTIN_ADAPTERS[idx] = adapter;
  } else {
    BUILTIN_ADAPTERS.push(adapter);
  }
}

export function listBuiltinAdapters(): ProviderAdapter[] {
  return [...BUILTIN_ADAPTERS];
}

export function findBuiltinAdapter(name: string): ProviderAdapter | undefined {
  return BUILTIN_ADAPTERS.find((a) => a.name === name.toLowerCase());
}

// ─── Helpers for the wizard boilerplate ────────────────────────────────────

/**
 * Returns the boilerplate template the wizard emits for new adapters.
 * Operators are expected to substitute real endpoint URLs and capability
 * flags in place of the TODO markers.
 */
export function generateAdapterBoilerplate(providerName: string): string {
  const name = providerName.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return `import { ProviderAdapter, ProviderCapabilities, ProviderEndpoints } from "../../../providerOnboarding/adapterSpec";

export const ${name}Adapter: ProviderAdapter = {
  name: "${name}",
  displayName: "${name} (TODO)",

  getEndpoints(): ProviderEndpoints {
    return {
      sandbox: "https://sandbox.${name}.example.com",
      production: "https://api.${name}.example.com",
      healthUrl: "https://sandbox.${name}.example.com/health",
    };
  },

  getCapabilities(): ProviderCapabilities {
    return {
      supportsPayment: true,
      supportsPayout: true,
      supportsBatchPayout: false,
      supportsStatusQuery: true,
      supportsBalance: false,
      authMode: "direct",
      supportedCurrencies: ["XAF"],
      defaultCurrency: "XAF",
      maxBatchSize: undefined,
      healthCheckIntervalMinutes: 5,
      notes: ["TODO: replace sandbox URL with the real ${name} sandbox host"],
    };
  },

  getRequiredCredentialFields() {
    return ["apiKey", "apiSecret"] as const;
  },

  instantiate() {
    // TODO: import your axios/fetch client, call credentialManager
    // to fetch credentials by environment, then return a real instance.
    throw new Error("${name} adapter not yet wired up — see docs/PROVIDER_ADAPTER_SPEC.md");
  },
};
`;
}
