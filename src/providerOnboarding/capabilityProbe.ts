/**
 * Provider Capability Detection
 *
 * Issue #187 — Provider Onboarding Workflow, acceptance criterion #5.
 *
 * Two layers:
 *
 * 1. STATIC MANIFEST — every ProviderAdapter exposes getCapabilities()
 *    synchronously. This is the authoritative capability matrix and is
 *    what the onboarding wizard, dashboard, and integration checklist
 *    consult. Static declarations avoid the brittleness of HTTP-driven
 *    capability probing (which produces false negatives when rate limits
 *    or auth-mode mismatches are in play).
 *
 * 2. LIVE VALIDATION — given a remote endpoint and an auth mode, runs a
 *    short probe ("is GET /health reachable with these credentials?")
 *    and merges the result into the static manifest to produce a
 *    `ProviderCapabilitiesReport`. This is optional and surfaced via
 *    `validateCapabilitiesLive()` only — never used as the source of
 *    truth for routing decisions.
 */

import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderEnvironment,
} from "./adapterSpec";
import { findBuiltinAdapter } from "./adapterSpec";

export type CapabilityStatus = "supported" | "unsupported" | "indeterminate";

export interface ProviderCapabilitiesReport {
  providerName: string;
  environment: ProviderEnvironment;
  staticCapabilities: ProviderCapabilities;
  live?: {
    reachable: boolean;
    responseTimeMs: number | null;
    httpStatus: number | null;
    observedAt: string;
  };
  /**
   * Map of "capability name" → status. The status reflects the static
   * manifest merged with the optional live probe result.
   */
  matrix: Record<
    | "payment"
    | "payout"
    | "batchPayout"
    | "statusQuery"
    | "balance"
    | "health",
    CapabilityStatus
  >;
  warnings: string[];
}

/**
 * Reads the static capability manifest of an adapter. Cheap; safe in
 * hot paths (e.g. the routing layer that decides which provider to use
 * for a given currency).
 */
export function getStaticCapabilities(
  providerName: string,
): ProviderCapabilities | null {
  const adapter = findBuiltinAdapter(providerName);
  if (!adapter) return null;
  try {
    return adapter.getCapabilities();
  } catch {
    return null;
  }
}

/**
 * Robustly performs an HTTP GET against the provider's health URL.
 * Returns null when the adapter has no healthUrl or when fetch fails.
 * Exposed for tests; never throws.
 */
export async function probeReachability(
  providerName: string,
  environment: ProviderEnvironment,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 4_000,
): Promise<ProviderCapabilitiesReport["live"]> {
  const adapter = findBuiltinAdapter(providerName);
  if (!adapter) {
    return {
      reachable: false,
      responseTimeMs: null,
      httpStatus: null,
      observedAt: new Date().toISOString(),
    };
  }

  let url: string;
  try {
    const endpoints = adapter.getEndpoints();
    url =
      environment === "production"
        ? endpoints.production
        : endpoints.healthUrl || endpoints.sandbox;
  } catch {
    return {
      reachable: false,
      responseTimeMs: null,
      httpStatus: null,
      observedAt: new Date().toISOString(),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const response = await fetchFn(url, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timer);
    return {
      reachable: response.status < 500,
      responseTimeMs: Date.now() - start,
      httpStatus: response.status,
      observedAt: new Date().toISOString(),
    };
  } catch {
    clearTimeout(timer);
    return {
      reachable: false,
      responseTimeMs: null,
      httpStatus: null,
      observedAt: new Date().toISOString(),
    };
  }
}

/**
 * Builds the full capability report. Always succeeds — issues are
 * surfaced via the `warnings` array instead of thrown errors.
 */
export async function buildCapabilitiesReport(
  providerName: string,
  environment: ProviderEnvironment = "sandbox",
  fetchFn?: typeof fetch,
): Promise<ProviderCapabilitiesReport | null> {
  const adapter = findBuiltinAdapter(providerName);
  if (!adapter) return null;

  const staticCapabilities = (() => {
    try {
      return adapter.getCapabilities();
    } catch (err) {
      return {
        supportsPayment: false,
        supportsPayout: false,
        supportsBatchPayout: false,
        supportsStatusQuery: false,
        supportsBalance: false,
        authMode: "direct" as const,
        supportedCurrencies: [],
        defaultCurrency: "",
      };
    }
  })();

  const live = fetchFn
    ? await probeReachability(providerName, environment, fetchFn)
    : undefined;

  const matrix = {
    payment: statusFor(staticCapabilities.supportsPayment, live?.reachable),
    payout: statusFor(staticCapabilities.supportsPayout, live?.reachable),
    batchPayout: statusFor(
      staticCapabilities.supportsBatchPayout,
      live?.reachable,
    ),
    statusQuery: statusFor(
      staticCapabilities.supportsStatusQuery,
      live?.reachable,
    ),
    balance: statusFor(staticCapabilities.supportsBalance, live?.reachable),
    health: live ? statusFor(true, live.reachable) : "indeterminate",
  } as ProviderCapabilitiesReport["matrix"];

  const warnings: string[] = [];
  if (staticCapabilities.supportedCurrencies.length === 0) {
    warnings.push("provider declares no supported currencies");
  }
  if (!staticCapabilities.defaultCurrency) {
    warnings.push("provider declares no default currency");
  }
  if (live && !live.reachable && adapter.name !== "mock") {
    warnings.push(
      `provider ${adapter.name} ${environment} endpoint unreachable (HTTP ${live.httpStatus ?? "timeout"})`,
    );
  }

  return {
    providerName: adapter.name,
    environment,
    staticCapabilities,
    live,
    matrix,
    warnings,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function statusFor(
  declared: boolean,
  reachable: boolean | undefined,
): CapabilityStatus {
  if (!declared) return "unsupported";
  if (reachable === undefined) return "supported";
  return reachable ? "supported" : "indeterminate";
}

/**
 * Convenience helper that lets the onboarding wizard print a one-line
 * capability matrix.
 */
export function describeCapabilities(
  providerName: string,
): string | null {
  const adapter = findBuiltinAdapter(providerName);
  if (!adapter) return null;
  const caps = adapter.getCapabilities();
  const flags = [
    caps.supportsPayment && "payment",
    caps.supportsPayout && "payout",
    caps.supportsBatchPayout && `batchPayout(${caps.maxBatchSize ?? "n/a"})`,
    caps.supportsStatusQuery && "statusQuery",
    caps.supportsBalance && "balance",
  ].filter(Boolean);
  return [
    adapter.name,
    `[${caps.authMode}]`,
    flags.join(", "),
    `currencies=${caps.supportedCurrencies.join("|")}`,
  ].join(" • ");
}
