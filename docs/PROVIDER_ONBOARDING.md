# Provider Onboarding Workflow

> **Issue:** #187 — Implement Provider Onboarding Workflow
> **Audience:** Operators integrating new Mobile Money providers into
> ProxyPay. The companion developer doc is
> [`PROVIDER_ADAPTER_SPEC.md`](./PROVIDER_ADAPTER_SPEC.md).

## What this gives you

A single, repeatable pipeline for adding a new mobile money provider:

```
   ┌───────────────────┐    ┌───────────────────┐    ┌───────────────────┐
   │ 1. init           │ →  │ 2. creds          │ →  │ 3. health         │
   │ emit adapter file │    │ encrypt secrets   │    │ register watchdog │
   └───────────────────┘    └───────────────────┘    └───────────────────┘
            │                       │                       │
            ▼                       ▼                       ▼
   ┌───────────────────┐    ┌───────────────────┐    ┌───────────────────┐
   │ 4. sandbox        │ →  │ 5. evaluate       │ →  │ 6. live           │
   │ E2E test runner   │    │ checklist pass?   │    │ promote to live   │
   └───────────────────┘    └───────────────────┘    └───────────────────┘
```

The whole workflow lives in
[`src/providerOnboarding/`](../src/providerOnboarding) and is driven
from the
[`provider-onboard` CLI](../src/scripts/provider-onboard.ts). Every
sub-command is also a programmatic API on the exported class
instances, so a full pipeline can be called from a script or a CI
job.

## Before you start

1. Read [`PROVIDER_ADAPTER_SPEC.md`](./PROVIDER_ADAPTER_SPEC.md) so
   you understand the contract your adapter must satisfy.
2. Make sure the migration
   `20260624_create_provider_onboarding_tables.sql` has been applied:
   ```bash
   npm run migrate:up
   ```
   The migration creates three tables:
   - `provider_credentials` — encrypted credentials
   - `provider_health_configs` — DB-backed health check rows
   - `provider_onboarding_state` — per-step checklist state

## Step 1 — emit the adapter

Generate a starter file at
`src/services/mobilemoney/providers/<name>.adapter.ts`:

```bash
npm run provider:onboard -- init vodacom
```

Open the file and fill in:

- `getEndpoints()` — sandbox / production / health URLs.
- `getCapabilities()` — feature flags + supported currencies.
- `getRequiredCredentialFields()` — credential fields driven by
  `authMode`.
- `instantiate()` — return a real provider instance.

Save and re-typecheck:

```bash
npm run type-check
```

## Step 2 — store credentials

Encrypt + persist the credentials. The wizard uses AES-256-GCM via
[`src/utils/encryption.ts`](../src/utils/encryption.ts); the cleartext
secret material lives only in memory after a successful
`readCredentials()` call.

```bash
npm run provider:onboard -- creds vodacom \
  --auth-mode direct --api-key xxx --api-secret yyy
```

For OAuth-based providers:

```bash
npm run provider:onboard -- creds vodacom \
  --auth-mode oauth \
  --client-id cid --client-secret csec
```

For web-portal providers (Orange-style browser sessions):

```bash
npm run provider:onboard -- creds vodacom \
  --auth-mode web \
  --username ops --password hunter2
```

Per-provider limits must exist in env or `appConfig.ts` so the
`limits_configured` checklist step passes:

```bash
export VODACOM_MIN_AMOUNT=100
export VODACOM_MAX_AMOUNT=750000
```

## Step 3 — register the health check

The watchdog (`src/jobs/providerHealthCheck.ts`) pings every active
provider every five minutes. Register a row that points at a
lightweight endpoint (prefer a `/ping` or `/health` path):

```bash
npm run provider:onboard -- health vodacom \
  --url https://api.vodacom.example/health \
  --timeout-ms 5000
```

The row lands in `provider_health_configs` with `enabled = TRUE`.
The runtime list (`resolveHealthConfigs()` in
[`healthCheckSetup.ts`](../src/providerOnboarding/healthCheckSetup.ts))
unions the rows with the in-code `DEFAULT_PROVIDERS` array, giving
DB-based onboarding precedence so operators can override URLs
without a redeploy.

## Step 4 — run the sandbox test

The sandbox runner builds an in-process environment that mimics the
contract a production call would face. When `IS_SANDBOX=true` the
runner proxies calls to the local provider-mock server (start it
with `npm run provider-mock:dev` if needed) — meaning the command
works without internet access:

```bash
npm run provider-mock:dev &     # in a second terminal
npm run provider:onboard -- sandbox vodacom
```

Output:

```
Sandbox report for "vodacom" (sandbox):
  ✓ payment   87ms payment accepted
  ✓ payout    91ms payout accepted
  ✓ statusQuery 12ms status=completed
Sandbox summary: 3/3 sandbox operations succeeded
```

The runner persists the verdict into
`provider_onboarding_state.steps.sandbox_e2e_passed` so the next
`evaluate` run picks it up.

## Step 5 — evaluate the checklist

Every step has an evaluator. Re-running `evaluate` after a fix
updates the row and flips the overall status to `ready` once all
eight steps pass:

```bash
npm run provider:onboard -- evaluate vodacom
```

The eight steps (defined in
[`checklist.ts`](../src/providerOnboarding/checklist.ts)):

| # | Step                          | Description                                                                 |
| - | ----------------------------- | --------------------------------------------------------------------------- |
| 1 | `adapter_registered`          | The ProviderAdapter passes `validateAdapter()` and is in the registry.      |
| 2 | `capabilities_declared`       | `supportedCurrencies` and `defaultCurrency` are populated.                 |
| 3 | `credentials_issued`          | Row exists in `provider_credentials` and decrypts successfully.             |
| 4 | `sandbox_e2e_passed`          | The provider-mock / sandbox run wrote a passed verdict.                     |
| 5 | `health_check_registered`     | An enabled row exists in `provider_health_configs`.                        |
| 6 | `limits_configured`           | `<NAME>_MIN_AMOUNT` and `<NAME>_MAX_AMOUNT` env vars are present and valid. |
| 7 | `alerts_configured`           | `PAGERDUTY_INTEGRATION_KEY` is set; a dedup key is registered.              |
| 8 | `documentation_published`     | Operator marks the runbook check as passed via `checklistManager.markStep`. |

## Step 6 — promote to `live`

Once the checklist reports `ready`, you can flip the provider's
status manually by injecting a `live` status row, or by promoting it
once feature-flag toggling ships. The runtime orchestrator simply
relies on the credentials + health-check row, it does not gate on
the status field — flipping `status` is an audit / dashboard
concern, not a routing one.

## Running the full pipeline in one shot

A `demo` sub-command chains health → sandbox → evaluate. Use it as a
smoke test after every credential rotation:

```bash
npm run provider:onboard -- demo vodacom --url https://api.vodacom.example/health
```

## Inspecting state

| Command                                       | What it shows                                                              |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| `npm run provider:onboard -- list`            | Every adapter with its current checklist status.                           |
| `npm run provider:onboard -- status vodacom`  | Per-step status with timestamps.                                           |
| `npm run provider:onboard -- creds vodacom …` | Overwrites the encrypted row. Bumps `last_rotated_at` for audit.            |

## Security model

- Credentials are encrypted with AES-256-GCM, key derived from
  `DB_ENCRYPTION_KEY` via HKDF-SHA-256 with the `provider-credential`
  HKDF info label. Stored in `provider_credentials.encrypted_payload`
  as `<version>:<iv>:<authTag>:<ciphertext>`.
- The same key rotation rules from `src/utils/encryption.ts` apply —
  set `DB_ENCRYPTION_KEYS` JSON or `DB_ENCRYPTION_KEY_<version>` env
  vars to maintain multiple key versions during rotation.
- Cleartext secrets returned from `credentialManager.readCredentials()`
  must never be logged, echoed back to clients, or persisted back
  through any path other than the credential manager's own
  `upsertCredentials()`.
- The wizard CLI takes care to hide secrets in its output — only the
  presence (`key=true`) and the rotation timestamp are shown.

## Operational runbook for a known-good provider

Added providers should follow this order:

1. Generate the adapter boilerplate (`init`).
2. Implement `instantiate()` and unit-test in isolation.
3. Issue and store credentials (`creds`).
4. Register a sandbox health endpoint (`health`).
5. Run the E2E runner (`sandbox`) and confirm all green.
6. Evaluate the checklist (`evaluate`) and confirm `ready`.
7. Promote the provider into the routing layer via
   `PROVIDER_BACKUP_<PRIMARY>` env overrides or by adding to the
   failover chain in `mobileMoneyService_impl.js`.
8. Document in [`docs/providers/<name>.md`](./) using the boilerplate
   in [`docs/PROVIDER_ADAPTER_SPEC.md`](./PROVIDER_ADAPTER_SPEC.md) as
   a starting reference.

## Troubleshooting

| Symptom                                                       | Likely cause                                                                                      | Fix                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `validateAdapter fails: name must be lowercase`               | Adapter name has capitals or unsupported characters.                                              | Use `vodacom-tz`, not `Vodacom TZ` or `Vodacom_TZ!`.                                               |
| `creds` rejects with `requires --api-key`                     | `--auth-mode` is wrong, or you forgot to pass the matching flag.                                  | Re-run `creds` with the right flags.                                                              |
| `sandbox` reports `no builtin adapter`                       | Adapter is in `builtinAdapters.ts` but was never registered.                                      | Import `../providerOnboarding/builtinAdapters` from your entrypoint so side-effects fire.         |
| `evaluate` stays in `in_progress` even though steps look green | One of the tests reads the DB and fails because the row is missing.                              | Check `provider_onboarding_state.steps.sandbox_e2e_passed.notes` — often "no sandbox E2E result recorded yet". Run `sandbox` first. |
| Health watchdog is silent for a new provider                 | Row was registered with `enabled = FALSE`, or the URL never resolves.                             | Run `disableProvider`/`register` again; verify with `pingProvider(<config>)`.                     |
| `provider-mock:dev` not running on port 4010                  | Sandbox runner can't reach the mock under `IS_SANDBOX=true`.                                       | Start `npm run provider-mock:dev` before running `sandbox`.                                      |

## File map

| File                                                                                  | Purpose                                                |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [`src/providerOnboarding/adapterSpec.ts`](../src/providerOnboarding/adapterSpec.ts)     | Adapter interface + `validateAdapter` runtime lints.  |
| [`src/providerOnboarding/builtinAdapters.ts`](../src/providerOnboarding/builtinAdapters.ts) | MTN/Airtel/Orange/Mock registrations.                  |
| [`src/providerOnboarding/capabilityProbe.ts`](../src/providerOnboarding/capabilityProbe.ts) | Static + optional live capability matrix.             |
| [`src/providerOnboarding/credentialManager.ts`](../src/providerOnboarding/credentialManager.ts) | AES-256-GCM credential CRUD.                           |
| [`src/providerOnboarding/checklist.ts`](../src/providerOnboarding/checklist.ts)         | 8-step onboarding checklist + DB state.                |
| [`src/providerOnboarding/sandboxTest.ts`](../src/providerOnboarding/sandboxTest.ts)     | In-process E2E sandbox runner.                        |
| [`src/providerOnboarding/healthCheckSetup.ts`](../src/providerOnboarding/healthCheckSetup.ts) | Registers DB-backed health-check rows; unions with `DEFAULT_PROVIDERS`. |
| [`src/scripts/provider-onboard.ts`](../src/scripts/provider-onboard.ts)                 | CLI entrypoint — the wizard.                          |
| [`migrations/20260624_create_provider_onboarding_tables.sql`](../migrations/20260624_create_provider_onboarding_tables.sql) | Schema for the workflow tables.                        |
