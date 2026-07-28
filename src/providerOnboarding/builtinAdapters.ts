/**
 * Built-in Provider Adapters
 *
 * Registers the four providers shipped with ProxyPay — MTN, Airtel,
 * Orange, and Mock — into the adapterSpec registry so the wizard,
 * dashboard, and onboarding checklist can introspect their capabilities
 * uniformly.
 *
 * Each adapter's `instantiate()` returns the existing per-provider
 * class instance from `src/services/mobilemoney/providers/<name>.ts`,
 * NOT the orchestrator `MobileMoneyService`. The sandbox runner and
 * the wizard call `requestPayment` / `sendPayout` directly on the
 * returned instance.
 */

import {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderEndpoints,
  registerBuiltinAdapter,
} from "./adapterSpec";
import type { ProviderAdapterInstance } from "./adapterSpec";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClassCtor = new () => any;

function loadClass(modulePath: string, exportName: string): ClassCtor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = require(modulePath) as Record<string, ClassCtor>;
  return mod[exportName];
}

// ─────────────────────────────────────────────────────────────────────────
// MTN
// ─────────────────────────────────────────────────────────────────────────

const mtnAdapter: ProviderAdapter = {
  name: "mtn",
  displayName: "MTN Mobile Money",
  getEndpoints(): ProviderEndpoints {
    return {
      sandbox:
        process.env.MTN_BASE_URL ?? "https://sandbox.momodeveloper.mtn.com",
      production:
        process.env.MTN_PRODUCTION_URL ?? "https://momodeveloper.mtn.com",
      healthUrl:
        process.env.MTN_HEALTH_URL ??
        "https://sandbox.momodeveloper.mtn.com/v1_0/apiuser",
    };
  },
  getCapabilities(): ProviderCapabilities {
    return {
      supportsPayment: true,
      supportsPayout: true,
      supportsBatchPayout: true,
      supportsStatusQuery: true,
      supportsBalance: true,
      maxBatchSize: 50,
      authMode: "api_key",
      supportedCurrencies: ["XAF", "EUR", "GHS", "UGX", "ZMW"],
      defaultCurrency: "XAF",
      healthCheckIntervalMinutes: 5,
      notes: [
        "Sandbox: https://sandbox.momodeveloper.mtn.com",
        "Required: MTN_API_KEY, MTN_API_SECRET, MTN_SUBSCRIPTION_KEY",
      ],
    };
  },
  getRequiredCredentialFields() {
    return ["apiKey", "apiSecret", "subscriptionKey"] as const;
  },
  instantiate() {
    return loadClass(
      "../services/mobilemoney/providers/mtn",
      "MTNProvider",
    )() as ProviderAdapterInstance;
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Airtel
// ─────────────────────────────────────────────────────────────────────────

const airtelAdapter: ProviderAdapter = {
  name: "airtel",
  displayName: "Airtel Money",
  getEndpoints(): ProviderEndpoints {
    return {
      sandbox:
        process.env.AIRTEL_BASE_URL ?? "https://openapi.airtel.africa",
      production:
        process.env.AIRTEL_PRODUCTION_URL ?? "https://openapi.airtel.africa",
      healthUrl:
        process.env.AIRTEL_HEALTH_URL ??
        "https://openapi.airtel.africa/auth/oauth2/token",
    };
  },
  getCapabilities(): ProviderCapabilities {
    return {
      supportsPayment: true,
      supportsPayout: true,
      supportsBatchPayout: false,
      supportsStatusQuery: true,
      supportsBalance: true,
      authMode: "direct",
      supportedCurrencies: ["NGN", "KES", "UGX", "TZS", "ZMW", "XAF"],
      defaultCurrency: "NGN",
      healthCheckIntervalMinutes: 5,
      notes: [
        "Direct OAuth2 REST API via /auth/oauth2/token",
        "Required: AIRTEL_API_KEY, AIRTEL_API_SECRET",
      ],
    };
  },
  getRequiredCredentialFields() {
    return ["apiKey", "apiSecret"] as const;
  },
  instantiate() {
    return loadClass(
      "../services/mobilemoney/providers/airtel",
      "AirtelService",
    )() as ProviderAdapterInstance;
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Orange
// ─────────────────────────────────────────────────────────────────────────

const orangeAdapter: ProviderAdapter = {
  name: "orange",
  displayName: "Orange Money",
  getEndpoints(): ProviderEndpoints {
    return {
      sandbox: process.env.ORANGE_BASE_URL ?? "https://sandbox.orange.com",
      production: process.env.ORANGE_PRODUCTION_URL ?? "https://api.orange.com",
      healthUrl:
        process.env.ORANGE_HEALTH_URL ??
        "https://api.orange.com/orange-money-webpay/dev/v1/webpayment",
    };
  },
  getCapabilities(): ProviderCapabilities {
    return {
      supportsPayment: true,
      supportsPayout: true,
      supportsBatchPayout: false,
      supportsStatusQuery: true,
      supportsBalance: false,
      authMode: "web",
      supportedCurrencies: ["XAF", "EUR", "USD"],
      defaultCurrency: "XAF",
      healthCheckIntervalMinutes: 5,
      notes: [
        "Web-session based integration (browser cookies)",
        "Required: ORANGE_USERNAME, ORANGE_PASSWORD",
      ],
    };
  },
  getRequiredCredentialFields() {
    return ["username", "password"] as const;
  },
  instantiate() {
    return loadClass(
      "../services/mobilemoney/providers/orange",
      "OrangeProvider",
    )() as ProviderAdapterInstance;
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Mock (development only)
// ─────────────────────────────────────────────────────────────────────────

const mockAdapter: ProviderAdapter = {
  name: "mock",
  displayName: "Mock (development)",
  getEndpoints(): ProviderEndpoints {
    const port = process.env.PROVIDER_MOCK_PORT || "4010";
    return {
      sandbox: `http://127.0.0.1:${port}`,
      production: `http://127.0.0.1:${port}`,
      healthUrl: `http://127.0.0.1:${port}/health`,
    };
  },
  getCapabilities(): ProviderCapabilities {
    return {
      supportsPayment: true,
      supportsPayout: true,
      supportsBatchPayout: false,
      supportsStatusQuery: true,
      supportsBalance: true,
      // Mock has no real credentials — the provider-mock-server is the
      // auth boundary. authMode "proxy" declares that authentication is
      // upstream of this adapter, so validateAdapter() correctly skips
      // the apiKey/apiSecret requirement.
      authMode: "proxy",
      supportedCurrencies: ["XAF", "NGN", "EUR"],
      defaultCurrency: "XAF",
      notes: ["Provider-mock server (scripts/provider-mock-server.ts)"],
    };
  },
  getRequiredCredentialFields() {
    return [] as const;
  },
  instantiate() {
    return loadClass(
      "../services/mobilemoney/providers/mock",
      "MockProvider",
    )() as ProviderAdapterInstance;
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Register every adapter. `registerBuiltinAdapter` runs `validateAdapter`
// so any dev that ships a malformed adapter here will fail at import
// time, not at runtime.
// ─────────────────────────────────────────────────────────────────────────

registerBuiltinAdapter(mtnAdapter);
registerBuiltinAdapter(airtelAdapter);
registerBuiltinAdapter(orangeAdapter);
registerBuiltinAdapter(mockAdapter);

export { mtnAdapter, airtelAdapter, orangeAdapter, mockAdapter };
