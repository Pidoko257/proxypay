# Provider Adapter Specification

> **Issue:** #187 — Implement Provider Onboarding Workflow
> **Owner:** Platform / Integrations
> **Status:** Accepted (this document is the authoritative contract)

## Purpose

This document specifies the interface every Mobile Money provider
implemented in ProxyPay must satisfy. It exists to (a) make adding a
new provider mechanical — operators follow the contract and ship a
file — and (b) make the onboarding tooling able to introspect every
provider uniformly so capabilities, credentials, health checks, and
sandbox tests all run against the same surface.

The contract lives in
[`src/providerOnboarding/adapterSpec.ts`](../src/providerOnboarding/adapterSpec.ts).
The runtime validator (`validateAdapter`) enforces everything that
TypeScript cannot — non-`https` URLs, unsupported currency codes,
auth-field mismatches, etc. — and is run automatically by the
`registerBuiltinAdapter()` call.

## Adapter surface

```ts
import {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderEndpoints,
} from "../../providerOnboarding/adapterSpec";

export const vodacomAdapter: ProviderAdapter = {
  name: "vodacom",
  displayName: "Vodacom M-Pesa",

  getEndpoints(): ProviderEndpoints {
    return {
      sandbox: "https://sandbox.vodacom.example.com",
      production: "https://api.vodacom.example.com",
      healthUrl: "https://sandbox.vodacom.example.com/health",
    };
  },

  getCapabilities(): ProviderCapabilities {
    return {
      supportsPayment: true,
      supportsPayout: true,
      supportsBatchPayout: false,
      supportsStatusQuery: true,
      supportsBalance: false,
      maxBatchSize: undefined,           // required only if supportsBatchPayout
      authMode: "direct",               // see auth-mode matrix below
      supportedCurrencies: ["XAF", "USD"],
      defaultCurrency: "XAF",
      healthCheckIntervalMinutes: 5,
      notes: ["Required: VODACOM_API_KEY", "Sandbox TTL: 24h"],
    };
  },

  getRequiredCredentialFields() {
    return ["apiKey", "apiSecret"] as const;
  },

  instantiate() {
    // Return a ProviderAdapterInstance — see spec below.
  },
};
```

### Required fields

| Field             | Type                | Notes                                                                                          |
| ----------------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| `name`            | `string`            | Lowercase, `[a-z0-9_-]{1,63}`, must match `/^[a-z]…/`. Used as the primary key everywhere.      |
| `displayName`     | `string`            | Human label shown in dashboards and CLI output.                                                |
| `getEndpoints()`  | `ProviderEndpoints` | Returns sandbox / production / optional `healthUrl`. Both base URLs must be `https://…`.       |
| `getCapabilities()` | `ProviderCapabilities` | Sync static manifest. Hot-path code relies on this — keep it cheap. |
| `getRequiredCredentialFields()` | `Array<CredentialFieldKey>` | Must include at least the fields dictated by `authMode`. |
| `instantiate()`   | `ProviderAdapterInstance` | Returns the runtime instance used by calls. Throws if not yet wired (e.g. before credentials are issued). |

### Auth-mode matrix

`authMode` drives which credential fields are required:

| `authMode`  | Required credential fields                                       |
| ----------- | ---------------------------------------------------------------- |
| `direct`    | `apiKey`, `apiSecret`                                            |
| `api_key`   | `apiKey`, `apiSecret`                                            |
| `oauth`     | `clientId`, `clientSecret`                                       |
| `web`       | `username`, `password`                                           |
| `proxy`     | (none — proxy performs auth upstream)                            |

A `ProviderAdapter.getRequiredCredentialFields()` that does NOT
include the above entries for its declared `authMode` fails
`validateAdapter()` at registration time.

### Capability flags

| Flag                       | What it implies                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `supportsPayment`          | `requestPayment(phoneNumber, amount, [requestId])` is implemented.                                    |
| `supportsPayout`           | `sendPayout(phoneNumber, amount, [requestId])` is implemented.                                        |
| `supportsBatchPayout`      | `sendBatchPayout(items, [requestId])` is implemented; `maxBatchSize` must be positive.                 |
| `supportsStatusQuery`      | `getTransactionStatus(referenceId)` is implemented.                                                   |
| `supportsBalance`          | The adapter exposes an operational balance endpoint.                                                 |
| `authMode`                 | One of `direct | api_key | oauth | web | proxy`.                                                      |
| `supportedCurrencies`      | ISO-4217 strings — used by the routing layer to choose the right provider for a given currency.        |
| `defaultCurrency`          | Must appear in `supportedCurrencies`.                                                                |
| `maxBatchSize`             | Required when `supportsBatchPayout` is true. Providers that exceed this limit must reject gracefully. |
| `healthCheckIntervalMinutes` | Operator hint for the watchdog cron; the runtime uses the cron from env, not this value.           |

### Endpoints

Both `sandbox` and `production` URLs MUST be `https://`. `healthUrl`
defaults to `sandbox` if omitted. The health-check watchdog only ever
pings `healthUrl`. Do not list an endpoint whose base URL changes
between requests — the watchdog caches the URL.

## Instance surface

`ProviderAdapter.instantiate()` returns a `ProviderAdapterInstance`
that the sandbox runner and the production orchestrator call
through. The shape mirrors the runtime contract in
`MobileMoneyProvider` ([`mobileMoneyService.ts`](../src/services/mobilemoney/mobileMoneyService.ts))
so existing providers slot in unchanged.

```ts
interface ProviderAdapterInstance {
  requestPayment(
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }>;

  sendPayout(
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }>;

  sendBatchPayout?(items, requestId?): Promise<{ success; results; error? }>;

  getTransactionStatus?(referenceId): Promise<{ status: "completed" | "failed" | "pending" | "unknown" }>;
}
```

The orchestrator in
[`mobileMoneyService_impl.js`](../src/services/mobilemoney/mobileMoneyService_impl.js)
calls `requestPayment` / `sendPayout` / `getTransactionStatus`
directly. Adding new operations requires a coordinated change to that
orchestrator and the wiring layer (`mobileMoneyService.ts`).

## Validation

`validateAdapter(adapter)` is invoked automatically when an adapter
is registered. It rejects name / display-name / endpoint /
capability / required-field combinations that violate the contract.
Adapters that pass `validateAdapter()` can be safely onboarded via
the wizard without further runtime checks.

```ts
import { validateAdapter, registerBuiltinAdapter } from
  "../../providerOnboarding/adapterSpec";

registerBuiltinAdapter(vodacomAdapter); // throws on contract violation
```

## Boilerplate generation

The wizard emits a starter file when invoked:

```
npm run provider:onboard -- init vodacom
```

The resulting file is a compiling skeleton — fill in URLs, capability
flags, credential field list, and the wire up in `instantiate()`.
Two follow-up commands push the provider through the wizard:

```
npm run provider:onboard -- creds vodacom --api-key … --api-secret …
npm run provider:onboard -- health vodacom --url https://api.vodacom.example/health
npm run provider:onboard -- sandbox vodacom
npm run provider:onboard -- evaluate vodacom
```

## Why dynamic registry + static manifest

Mobile Money APIs are heterogeneous and rate-limiting is aggressive.
A live capability probe produces noisy false negatives whenever a
provider is temporarily down or in the middle of cred rotation. The
adapter's `getCapabilities()` manifest is therefore the authoritative
source of truth; the optional live probe
(`buildCapabilitiesReport` in `capabilityProbe.ts`) is informational
only.

## See also

- [`PROVIDER_ONBOARDING.md`](./PROVIDER_ONBOARDING.md) — operational walkthrough.
- [`src/providerOnboarding/builtinAdapters.ts`](../src/providerOnboarding/builtinAdapters.ts) — the three shipped adapters.
- [`src/providerOnboarding/sandboxTest.ts`](../src/providerOnboarding/sandboxTest.ts) — sandbox runner contract.
