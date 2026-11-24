# ProxyPay Configuration Management Guide

## Overview

This document describes how ProxyPay manages sensitive configuration, particularly mobile money provider credentials (MTN, Airtel, Orange), across different environments (development, staging, production).

**Key Principle:** _Never log provider credentials in plain text._

## Architecture

### Components

1. **Credential Loader** (`src/config/credentialLoader.ts`)
   - Environment-specific credential validation
   - Mock credential detection
   - Fail-safe design with early exit on invalid configuration
   - Provides safe summaries for logging

2. **Redaction Utility** (`src/utils/redact.ts`)
   - Recursively walks and redacts sensitive fields
   - Patterns for provider credentials, API keys, secrets, tokens, etc.
   - Applied to all logged payloads automatically
   - Zero mutations — returns deep clones

3. **Logging Middleware** (`src/middleware/logger.ts`)
   - Uses `redact()` on all request/response bodies
   - Bounds payload size to prevent log bloat
   - Captures trace IDs for distributed tracing

4. **Error Handler** (`src/middleware/errorHandler.ts`)
   - Applies redaction before logging error details
   - Masks PII in error messages and stack traces
   - Never exposes credentials in error responses (production mode)

## Environment-Specific Behavior

### Development

- **Credential Requirements:** Optional
- **Mock Credentials:** Allowed
- **Empty Credentials:** Allowed
- **Validation:** Lenient — missing credentials don't fail startup

**Use Case:** Local development with provider mocks or real test credentials.

```bash
# Development .env (optional)
MTN_API_KEY=mock_mtn_key_dev
MTN_API_SECRET=mock_mtn_secret_dev
MTN_CALLBACK_SECRET=mock_mtn_callback
MTN_BASE_URL=https://mtn-dev-mock.local

# Or leave empty to use in-memory mocks
```

### Staging

- **Credential Requirements:** All providers must be configured
- **Mock Credentials:** Allowed
- **Empty Credentials:** Not allowed
- **Validation:** Strict — incomplete configuration fails startup

**Use Case:** Pre-production testing with staging provider APIs.

```bash
# Staging .env
MTN_API_KEY=staging_mtn_key_xyz
MTN_API_SECRET=staging_mtn_secret_abc
MTN_CALLBACK_SECRET=staging_mtn_callback_def
MTN_BASE_URL=https://staging.mtn.example.com

AIRTEL_API_KEY=staging_airtel_key_123
AIRTEL_API_SECRET=staging_airtel_secret_456
AIRTEL_CALLBACK_SECRET=staging_airtel_callback_789
AIRTEL_BASE_URL=https://staging.airtel.example.com

ORANGE_API_KEY=staging_orange_key_abc
ORANGE_API_SECRET=staging_orange_secret_def
ORANGE_CALLBACK_SECRET=staging_orange_callback_ghi
ORANGE_BASE_URL=https://staging.orange.example.com
```

### Production

- **Credential Requirements:** All providers must be configured with real credentials
- **Mock Credentials:** Rejected with immediate startup failure
- **Empty Credentials:** Rejected with immediate startup failure
- **Validation:** Strictest — only real credentials accepted

**Use Case:** Live production with real provider APIs.

```bash
# Production .env
# Must use real production credentials only
# Mock values like "mock_*", "test_*", "xxx...", etc. are rejected

MTN_API_KEY=prod_mtn_key_sk_live_real_...
MTN_API_SECRET=prod_mtn_secret_...
MTN_CALLBACK_SECRET=prod_mtn_callback_...
MTN_BASE_URL=https://api.mtn.prod.com

# Same for AIRTEL and ORANGE
```

## Loading Credentials

### Automatic Loading

Credentials are loaded automatically during application startup:

```typescript
import {
  loadAllProviderCredentials,
  validateEnvironmentCredentials,
} from "./config/credentialLoader";

// In your startup code
const environment = process.env.NODE_ENV || "development";
const credentials = loadAllProviderCredentials(environment);

// Or validate without loading
const validation = validateEnvironmentCredentials(environment);
if (!validation.valid) {
  console.error("Configuration invalid:", validation.errors);
  process.exit(1);
}
```

### Per-Provider Loading

Load individual provider credentials:

```typescript
import { loadProviderCredentials } from "./config/credentialLoader";

const mtnCreds = loadProviderCredentials("mtn", "production");
if (mtnCreds) {
  // Use credentials
  const client = new MTNClient(mtnCreds.apiKey, mtnCreds.apiSecret);
}
```

### Safe Logging

Use `getCredentialsSummary()` for safe logging without exposing secrets:

```typescript
import { getCredentialsSummary } from "./config/credentialLoader";

const summary = getCredentialsSummary(credentials);
console.log("Loaded providers:", JSON.stringify(summary));
// Output: {"mtn":{"loaded":true,"baseUrl":"https://mtn.com"},...}
// Secrets are NOT included
```

## Credential Validation Rules

### Mock Credential Detection

Credentials are considered "mock" if they match these patterns:

- Prefix patterns: `mock_*`, `test_*`, `dummy_*`, `aaa_*`, `bbb_*`, `ccc_*`
- Repeating characters: 10+ of the same character (`xxxxxxxxxx`)
- Examples:
  - ✗ `mock_key_12345` → Rejected in production
  - ✗ `test_secret_xyz` → Rejected in production
  - ✗ `xxxxxxxxxx` → Rejected in production
  - ✓ `sk_live_real_key_abc123` → Accepted in production

### Real Credential Requirements

In production, all of these must be set for each provider:

```
{PROVIDER}_API_KEY         (non-empty, non-mock)
{PROVIDER}_API_SECRET      (non-empty, non-mock)
{PROVIDER}_CALLBACK_SECRET (non-empty, non-mock)
{PROVIDER}_BASE_URL        (valid HTTPS URL)
```

Where `{PROVIDER}` is one of: `MTN`, `AIRTEL`, `ORANGE`

**Validation Error Examples:**

```
✗ Incomplete credentials (only API_KEY provided)
  → "Incomplete MTN credentials in production"

✗ Mock credentials in production
  → "Mock credentials for MTN are not allowed in production"

✗ Invalid in staging (no credentials)
  → "MTN credentials are required but not provided"
```

## Log Redaction

All logs automatically redact sensitive fields. Examples:

### Request/Response Body Redaction

```typescript
// Input to logging middleware
{
  amount: 5000,
  apiKey: "sk_live_secret_key",
  apiSecret: "sk_live_secret_secret",
  user_id: "user_123"
}

// Logged as
{
  amount: 5000,
  apiKey: "[REDACTED]",
  apiSecret: "[REDACTED]",
  user_id: "user_123"
}
```

### Sensitive Field Names

These field names are automatically redacted:

```
Credentials & Auth:
- apiKey, apiSecret, apisecret, api_secret, api-secret
- password, passwd, token, refreshToken
- authorization, bearer, cookie, x-api-key
- credentials, secret, seed, mnemonic
- privateKey, private_key, masterkey

Provider-Specific:
- callbackSecret, callback_secret, callback-secret
- mtn_api_key, airtel_api_key, orange_api_key
- mtn_api_secret, airtel_api_secret, orange_api_secret

Other Sensitive:
- ssn, cvv, cardnumber, accountnumber
- pin, otp, passphrase
```

### Production Log Example

```json
{
  "timestamp": "2024-10-16T15:22:04Z",
  "level": "ERROR",
  "provider": "mtn",
  "credentials": "[REDACTED]",
  "message": "Failed to initialize provider",
  "statusCode": 500
}
```

The `credentials` field (if present) is completely redacted, along with all nested sensitive fields.

## Best Practices

### 1. Never Log Full Configuration Objects

❌ **BAD:**

```typescript
logger.info("Config loaded:", fullCredentials);
// Might accidentally log secrets
```

✅ **GOOD:**

```typescript
const summary = getCredentialsSummary(credentials);
logger.info("Config loaded:", summary);
// Only logs safe fields like baseUrl and provider name
```

### 2. Use Environment-Specific Variables

❌ **BAD:**

```typescript
const apiKey = process.env.API_KEY; // Same for all environments
```

✅ **GOOD:**

```typescript
const apiKey = process.env[`${provider.toUpperCase()}_API_KEY`];
// Per-provider, per-environment variables
```

### 3. Validate Early

❌ **BAD:**

```typescript
// Discover config problems at runtime
if (!credentials.apiKey) {
  // Handle error deep in provider code
}
```

✅ **GOOD:**

```typescript
// Validate at startup
const validation = validateEnvironmentCredentials(env);
if (!validation.valid) {
  console.error("Invalid config:", validation.errors);
  process.exit(1);
}
```

### 4. Fail Safely in Production

- Production startup fails immediately if credentials are invalid
- Invalid configuration is never silently ignored
- No fallback to mock credentials in production

### 5. Log Provider Activity Safely

```typescript
// OK to log these (safe fields)
logger.info({
  provider: "mtn",
  baseUrl: credentials.baseUrl, // Safe to log
  status: "connected",
  transactionId: "txn_123",
});

// Logging happens with automatic redaction
// Even if unsafe fields are included, they'll be redacted
```

## Testing Configuration

### Unit Tests

Test credential loading in isolation:

```bash
npm test -- src/config/__tests__/credentialLoader.test.ts
```

### Integration Tests

Test multi-environment configuration flows:

```bash
npm test -- src/config/__tests__/multiEnvConfig.integration.test.ts
```

### Redaction Tests

Test that credentials are properly redacted in logs:

```bash
npm test -- src/config/__tests__/credentialRedaction.test.ts
```

## Troubleshooting

### Issue: "Mock credentials not allowed in production"

**Cause:** A credential value matches a mock pattern (starts with `mock_`, `test_`, etc.)

**Solution:** Use real production credentials from your provider account

```bash
# Before (BAD)
MTN_API_KEY=mock_key

# After (GOOD)
MTN_API_KEY=sk_live_abc123def456
```

### Issue: "Incomplete credentials"

**Cause:** Some credentials are set but not all four required fields

**Solution:** Set all four credentials for the provider

```bash
# Set ALL of these for each provider:
{PROVIDER}_API_KEY
{PROVIDER}_API_SECRET
{PROVIDER}_CALLBACK_SECRET
{PROVIDER}_BASE_URL
```

### Issue: "Credentials required but not provided" (in staging/production)

**Cause:** Environment requires credentials but none are set

**Solution:**

- For **development**: Leave credentials empty (optional)
- For **staging/production**: Set all required credentials

### Issue: Credentials appear in logs (not redacted)

**Likely cause:** Custom logging that bypasses redaction middleware

**Solution:** Use the provided logging utilities that apply redaction:

```typescript
import { redact } from "../utils/redact";

// Always redact before logging
const safe = redact(data);
logger.info(safe);
```

## Migration Guide

### From Unredacted to Redacted Logging

If you have existing logging that doesn't use redaction:

1. **Update middleware:**
   - Ensure `errorHandler` is imported (already updated)
   - Ensure `requestLogger` is used for HTTP requests

2. **Update service layer logging:**

   ```typescript
   // Before
   logger.info("Response:", response);

   // After
   logger.info("Response:", redact(response));
   ```

3. **Run tests:**
   ```bash
   npm test -- src/config/__tests__/
   ```

## Reference

### API

#### `loadProviderCredentials(provider, environment?)`

Load credentials for a specific provider in a specific environment.

```typescript
const creds = loadProviderCredentials("mtn", "production");
// Returns: ProviderCredentials | null

interface ProviderCredentials {
  apiKey: string;
  apiSecret: string;
  callbackSecret: string;
  baseUrl: string;
}
```

#### `loadAllProviderCredentials(environment?)`

Load all configured provider credentials.

```typescript
const creds = loadAllProviderCredentials("staging");
// Returns: LoadedCredentials

interface LoadedCredentials {
  mtn?: ProviderCredentials;
  airtel?: ProviderCredentials;
  orange?: ProviderCredentials;
  loadedAt: Date;
  environment: EnvironmentType;
}
```

#### `validateEnvironmentCredentials(environment?)`

Validate that an environment's credentials are properly configured.

```typescript
const result = validateEnvironmentCredentials("production");
// Returns: { valid: boolean; errors: string[] }
```

#### `getCredentialsSummary(credentials)`

Get a safe, redacted summary of loaded credentials for logging.

```typescript
const summary = getCredentialsSummary(credentials);
// Returns: { environment, loadedAt, mtn: {loaded, baseUrl}, ... }
```

#### `redact(value)`

Redact all sensitive fields from any value (used by middleware automatically).

```typescript
const safe = redact({
  apiKey: "secret",
  amount: 5000,
});
// Returns: { apiKey: '[REDACTED]', amount: 5000 }
```

---

**Last Updated:** October 2024  
**Maintainers:** ProxyPay Security Team
