chec# ProxyPay Backend Issues

**Note:** This audit checked the codebase for real backend issues. Many overlap with already-opened GitHub issues (see cross-references below). Issues listed here that do NOT reference a GitHub ticket are newly discovered.

---

## Money & Financial Correctness

### Floating-point arithmetic used for monetary amounts

- **Where:** src/services/transactionService.ts:38, src/services/feeService.ts:57-58
- **Language:** TypeScript
- **Problem:** Money handling uses JavaScript `parseFloat()` and arithmetic operations on floats, which causes precision loss. Line 38: `const currentBalance = parseFloat(user.rows[0].balance || "0");` and feeService lines 57-58 use `parseFloat(fee.toFixed(2))` which compounds the precision problem. Floating-point arithmetic is unsuitable for financial calculations because `0.1 + 0.2 !== 0.3` in JavaScript.
- **How to solve:** Store and calculate monetary amounts as integers (in smallest currency unit, e.g., cents). Use a BigDecimal library (e.g., `decimal.js` or `big.js`) for any calculations before converting back to the database integer format.

### TOCTOU race condition in withdraw operation

- **Where:** src/services/transactionService.ts:31-105 (withdraw method)
- **Language:** TypeScript
- **GitHub Issue:** #883
- **Problem:** The `withdraw()` method reads the balance at line 38 with `SELECT id, balance FROM users`, then later at line 56 performs `UPDATE users SET balance = balance - $1`. Between the read and write, another concurrent request could have withdrawn the same balance, causing a double-spend or negative balance. No `SELECT FOR UPDATE` lock is acquired before the read.
- **How to solve:** Use `SELECT ... FOR UPDATE` to acquire an exclusive row lock on the user record before reading the balance, holding it until after the balance is updated within the transaction.

### Missing balance update atomicity for fee calculation

- **Where:** src/services/transactionService.ts:123-135 (calculateWithdrawalFee)
- **Language:** TypeScript
- **Problem:** Fee configuration is queried and fees are calculated outside any transaction lock. If fee configuration changes mid-transaction, the amount deducted may not match what was shown to the user. The fee rows are fetched separately without any isolation guarantee, causing potential consistency issues when concurrent requests read different fee configs.
- **How to solve:** Move fee lookup and calculation inside the transaction block and use `SELECT ... FOR UPDATE` on the fee_configurations row if fetching active config, or use application-level caching with versioning to ensure consistency.

### No validation that fee minimum <= maximum

- **Where:** src/services/feeService.ts:190-215 (createConfiguration)
- **Language:** TypeScript
- **Problem:** The `createConfiguration()` method accepts `feeMinimum` and `feeMaximum` without validating that minimum <= maximum. A malicious or confused admin could set feeMinimum=1000 and feeMaximum=10, causing invalid clamping logic.
- **How to solve:** Add validation before insertion: `if (feeMinimum > feeMaximum) throw new Error("feeMinimum must be <= feeMaximum")`.

### Fee clamping order bug in feeService

- **Where:** src/services/feeService.ts:51-52
- **Language:** TypeScript
- **Problem:** The clamping logic `if (fee < config.feeMinimum) fee = config.feeMinimum; if (fee > config.feeMaximum) fee = config.feeMaximum;` may clamp the minimum first, then the maximum, leaving the final fee potentially above minimum if maximum < minimum (due to config error). This is an order-of-operations issue when config is malformed.
- **How to solve:** Validate config on load, and clamp in one operation: `fee = Math.max(config.feeMinimum, Math.min(fee, config.feeMaximum))`.

### Parsed amounts not validated for negative values

- **Where:** src/services/transactionService.ts:25, src/services/feeService.ts:49
- **Language:** TypeScript
- **Problem:** The `withdraw()` method checks `if (payload.amount < MIN_WITHDRAWAL_AMOUNT)` but does not reject negative amounts explicitly. If a malicious client sends `amount: -1000`, it passes the minimum check and could trigger unexpected ledger behavior. Similarly, fee service accepts negative fees without validation.
- **How to solve:** Explicitly validate: `if (amount < 0) throw new Error("Amount cannot be negative")` and apply the same to all monetary inputs.

### Missing currency normalization in fee calculation

- **Where:** src/services/feeService.ts and src/services/transactionService.ts:123-135
- **Language:** TypeScript
- **Problem:** The withdraw fee lookup queries `WHERE type = 'withdrawal' AND (currency = $1 OR currency = 'ALL')` but does not normalize currency codes (e.g., 'usd' vs 'USD'). A fee config stored as 'USD' will not match a query for 'usd', causing fallback to defaults and incorrect fee calculation.
- **How to solve:** Normalize currency codes to uppercase (or lowercase, consistently) before all database queries and comparisons. Use a utility function `normalizeCurrency()` on all inputs.

### Status state machine allows invalid transitions

- **Where:** src/services/dispute.ts:52-60 (TRANSITIONS constant)
- **Language:** TypeScript
- **Problem:** The TRANSITIONS map allows `open -> resolved` directly without requiring `investigating` as an intermediate state. This violates the documented workflow that should enforce `open -> investigating -> resolved`. Also, transitions to undefined status states like 'reversed' and 'upheld' are not documented in the comment but are hard-coded, breaking the state machine model.
- **How to solve:** Update the TRANSITIONS map to enforce the documented workflow: `open: ["investigating"]`, `investigating: ["resolved", "rejected"]`. Move 'reversed' and 'upheld' to a separate concern if they represent different final states, or document and enforce them consistently.

### Idempotency key not hashing request method or user ID

- **Where:** src/middleware/idempotency.ts:38-45 (hashRequest function)
- **Language:** TypeScript
- **Problem:** The idempotency hash includes method, path, and body but not the user ID. If user A and user B send identical POST payloads to the same endpoint, they will receive the same cached response, leaking user A's transaction to user B. The hash should include the authenticated user's ID.
- **How to solve:** Include `req.user?.id` in the hash: `crypto.createHash("sha256").update(\`${req.method}:${req.originalUrl}:${req.user?.id}:${JSON.stringify(req.body ?? {})}\`).digest("hex")`.

### Transaction reversal state transitions not validated

- **Where:** src/services/transactionReversalService.ts (ReversalStatus type and any status-update code)
- **Language:** TypeScript
- **Problem:** The reversal status enum allows `"requested" | "posted" | "notified" | "failed"` but no code validates that transitions follow a logical sequence (e.g., can't go from "failed" to "posted"). An edge case could post a ledger entry after the reversal is marked failed, violating accounting integrity.
- **How to solve:** Implement a state machine validation function that enforces `requested -> posted -> notified` or `requested -> failed` as the only valid paths, and reject other transitions.

### Double-entry ledger entry posting without balance validation

- **Where:** src/services/ledgerService.ts (PostedEntry and post operations)
- **Language:** TypeScript
- **Problem:** The ledger service posts debit and credit entries but does not validate that total debits equal total credits after posting a transaction. A bug in caller code could post only a debit without a matching credit, breaking the fundamental double-entry property.
- **How to solve:** After posting each transaction's entries, query `SELECT SUM(debit_amount) AS total_debits, SUM(credit_amount) AS total_credits FROM ledger_entries WHERE transaction_id = $1` and assert they are equal, logging an error if not.

### No locked row check before balance transfer

- **Where:** src/services/ledgerService.ts and src/services/accounting.ts
- **Language:** TypeScript
- **Problem:** Balance transfers (debits/credits) are executed without acquiring row-level locks on affected accounts. Concurrent transfers to the same account can race, causing the ledger to drift out of balance or double-count credits.
- **How to solve:** Use `SELECT ... FOR UPDATE` on all accounts involved in a posting before modifying their balances, and hold the lock until the transaction commits.

### Rounding mode not specified in fee calculations

- **Where:** src/services/feeService.ts:50-52
- **Language:** TypeScript
- **Problem:** The fee calculation uses standard JavaScript rounding, which defaults to "round half away from zero". Financial systems typically require banker's rounding (round half to even) or explicit floor/ceil. The `.toFixed(2)` method uses the system rounding, which can accumulate bias over millions of transactions.
- **How to solve:** Use explicit rounding mode: `fee = Math.round(fee * 100) / 100` for standard rounding, or use a library like `decimal.js` that supports banker's rounding, configurable per-transaction type.

### Withdrawal ledger entry creation missing transaction ID

- **Where:** src/services/transactionService.ts:94-102 (INSERT INTO withdrawal_ledger)
- **Language:** TypeScript
- **Problem:** The withdrawal_ledger insert at line 94 includes `transaction_id`, but if the transaction creation fails or is rolled back, the ledger entry remains orphaned. Also, there's no check that the transaction was actually created before inserting the ledger entry.
- **How to solve:** Move the ledger entry insert after successful transaction creation, use the returned transaction ID, and wrap all operations in a transaction with explicit rollback on any error.

### Amount precision lost in parseFloat for balance checks

- **Where:** src/services/transactionService.ts:38-39
- **Language:** TypeScript
- **Problem:** `const currentBalance = parseFloat(user.rows[0].balance || "0"); if (currentBalance < payload.amount)` — the balance is parsed as a float, losing precision for large amounts. A balance of 999999999.999999 + 0.000001 might compare incorrectly due to float precision limits.
- **How to solve:** Keep balance as a string or integer from the database, perform all comparisons using string/integer math or a BigDecimal library, never convert to float for financial logic.

## Authentication & Authorization

### JWT tokens lack audience and issuer validation

- **Where:** src/auth/jwt.ts:258-285 (verifyToken function)
- **Language:** TypeScript
- **Problem:** The `verifyToken()` function verifies the signature and expiry but does not validate `aud` (audience) or `iss` (issuer) claims. A JWT issued by a different service or for a different audience could be accepted if the signature secret is ever leaked or shared.
- **How to solve:** Add `aud` and `iss` claims to tokens at generation time, and validate them during verification: check `decoded.aud === process.env.JWT_AUDIENCE` and `decoded.iss === process.env.JWT_ISSUER`.

### Hardcoded JWT expiration times not configurable

- **Where:** src/auth/jwt.ts:12-13
- **Language:** TypeScript
- **Problem:** `const JWT_EXPIRES_IN = "1h"; const REFRESH_TOKEN_EXPIRES_IN = "7d";` are hardcoded constants. These should be environment variables so ops can adjust token lifetime without code changes. A 1-hour token is also quite short for mobile money use cases.
- **How to solve:** Replace with `process.env.JWT_EXPIRES_IN || "1h"` and `process.env.JWT_REFRESH_TOKEN_EXPIRES_IN || "7d"`, and document the format.

### Session binding validation incomplete

- **Where:** src/auth/jwt.ts:314-323 (verifyTokenStateful function)
- **Language:** TypeScript
- **Problem:** The session binding check at line 318 validates `session.binding !== binding` but `binding` is created from `createSessionBinding(deviceId, userAgent)` which uses SHA256 hash of these values. If a device ID or user agent is empty/missing, the hash becomes predictable, and an attacker could forge a valid binding.
- **How to solve:** Require both deviceId and userAgent to be present and non-empty before hashing. Add validation: `if (!deviceId || !userAgent) throw new Error("Device ID and User-Agent required for session binding")`.

### No rate limit on token refresh endpoint

- **Where:** src/auth/jwt.ts and authentication routes (likely in src/routes/auth.ts)
- **Language:** TypeScript
- **Problem:** The `generateRefreshToken()` function is called without rate limiting. An attacker could forge many refresh tokens (if the refresh endpoint is not separately rate-limited) and exhaust token storage or cause token lookup delays.
- **How to solve:** Implement a dedicated rate limit middleware on the refresh token endpoint (e.g., 5 refresh requests per minute per user).

### No expiry validation for refresh token family chain

- **Where:** src/auth/jwt.ts:233-251 (generateRefreshToken and family tracking)
- **Language:** TypeScript
- **Problem:** The refresh token family model stores tokens with no explicit expiry check. A family can accumulate unlimited old tokens if the cleanup job fails, and an attacker could replay an old token to forge a chain.
- **How to solve:** Add an `expires_at` column to the refresh_token_family table, set it to (now + REFRESH_TOKEN_EXPIRES_IN + grace period), and query only unexpired families during verification.

### Impersonation readOnly flag not enforced at database level

- **Where:** src/middleware/auth.ts:40-58 (rejectMutationDuringImpersonation)
- **Language:** TypeScript
- **Problem:** The readOnly flag is only checked at the middleware level. If an attacker bypasses middleware (e.g., via a direct SQL query or background job that reads req.jwtUser), the readOnly check is skipped. The claim should be reflected in the user's database permissions as well.
- **How to solve:** Check the `readOnly` flag when loading user permissions, and include it in the RBAC decision in the `rbac.ts` middleware as well, not just in auth.ts.

### API key expiry check uses string comparison instead of date comparison

- **Where:** src/middleware/auth.ts:95-96
- **Language:** TypeScript
- **Problem:** Line 96: `if (row.expires_at && new Date(row.expires_at) < new Date())` — string-to-Date conversion can fail or be locale-dependent. If the database stores timestamps in an unexpected format, the comparison may be incorrect.
- **How to solve:** Ensure the database column is a proper TIMESTAMP or TIMESTAMPTZ type, and use direct SQL comparison: `AND expires_at > CURRENT_TIMESTAMP` in the query itself instead of checking in application code.

### No audit logging for API key lookups or usage

- **Where:** src/middleware/auth.ts:90-105
- **Language:** TypeScript
- **Problem:** When an API key is used, there is no audit log entry. An attacker with a stolen key could make unlimited requests without any logging trail, complicating incident response.
- **How to solve:** Add an audit log entry after successful API key verification: `await auditlogService.log({ action: 'API_KEY_USED', apiKeyId, userId, timestamp: Date.now() })`.

### OAuth token verification swallowed without logging in fallback

- **Where:** src/middleware/auth.ts:124-136
- **Language:** TypeScript
- **Problem:** The OAuth token verification at line 124 throws an error that is caught silently, then falls through to try SEP-10. If the OAuth token is invalid, the error is not logged, making it hard to debug auth failures or detect attacks.
- **How to solve:** Log the OAuth verification error before falling through: `catch (err) { logger.debug('OAuth verification failed', err); }`.

### No protection against concurrent token revocation

- **Where:** src/auth/jwt.ts:320-323 (JWT invalidation in Redis)
- **Language:** TypeScript
- **Problem:** The session lookup at line 320 checks Redis, but if the same token is being used in multiple concurrent requests, there's no atomic compare-and-swap. An attacker could race to use a revoked token before the revocation is visible across all servers.
- **How to solve:** Use Redis WATCH to ensure that session revocation is atomic, or use a sequence number in the JWT that must match a server-side value.

### Session expiry not enforced during verification

- **Where:** src/auth/jwt.ts:310-323 (verifyTokenStateful)
- **Language:** TypeScript
- **Problem:** The function verifies the JWT expiry via `verifyToken()` but does not re-check the JWT max_concurrent_sessions limit. An old token could be replayed if it's still cryptographically valid but the user has since logged in on new devices and exceeded the session count.
- **How to solve:** After verifying the token, fetch the user's current session count from Redis and reject if it exceeds `JWT_MAX_CONCURRENT_SESSIONS`.

### No CSRF token validation on state-changing endpoints

- **Where:** src/middleware/auth.ts (and throughout the app)
- **Language:** TypeScript
- **Problem:** The auth middleware checks JWT/OAuth/API key but does not validate CSRF tokens. A malicious website could embed a form that submits a transfer request to the ProxyPay API using a victim's cookies.
- **How to solve:** For any non-GET request from a browser context (User-Agent contains "Mozilla"), require a CSRF token header (`X-CSRF-Token`) that matches a server-side session value.

### No strict Content-Type validation on POST/PUT requests

- **Where:** Applies across all routes, but not enforced in auth.ts
- **Language:** TypeScript
- **Problem:** The auth middleware accepts any Content-Type. An attacker could craft a form-encoded POST request instead of JSON, potentially bypassing JSON schema validation if the application relies on JSON parsing errors to reject invalid input.
- **How to solve:** Add middleware to strictly enforce `Content-Type: application/json` on all POST/PUT/PATCH endpoints, rejecting any other type.

## Rate Limiting & DoS Protection

### Rate limit key collision between users and IPs

- **Where:** src/middleware/rateLimit.ts:1200 (RATE_LIMIT_CONFIG and tier middleware)
- **Language:** TypeScript
- **Problem:** If rate limiting uses IP as the key for some endpoints and user ID for others, and user A is behind the same NAT as user B, they will share a rate limit bucket. One user could exhaust the limit and block the other.
- **How to solve:** Always key by user ID when authenticated, and only fall back to IP for unauthenticated endpoints. Document this in the rateLimit config.

### No distributed rate limiting across instances

- **Where:** src/middleware/rateLimitRedis.ts (if it exists) or src/middleware/rateLimit.ts
- **Language:** TypeScript
- **Problem:** If rate limits are stored in-process (not in Redis), each server instance has its own bucket. An attacker with knowledge of the load-balancer could hit 5 requests on instance A, then 5 on instance B, effectively bypassing the limit.
- **How to solve:** Always store rate limit counters in Redis (or a central store), not in-process memory. Use Redis INCR with EX to ensure all instances see the same counter.

### Recovery endpoint rate limit window too generous

- **Where:** src/middleware/rateLimit.ts:1200 (RECOVERY*WINDOW_MS = 15 * 60 \_ 1000)
- **Language:** TypeScript
- **Problem:** The SEP-30 recovery flow (key recovery) is limited to 5 attempts per 15 minutes. However, 15 minutes is a long window; an attacker could make 5 attempts, wait 900 seconds, and make 5 more attempts, effectively trying 10 combinations per hour.
- **How to solve:** Consider a shorter window (5 minutes) or require exponential backoff between attempts (2s, 4s, 8s, etc.), capping at 5 minutes.

### No sliding-window rate limiting implementation

- **Where:** src/middleware/slidingWindowRateLimit.ts (filename suggests it exists but content not reviewed)
- **Language:** TypeScript
- **Problem:** If fixed-window rate limiting is used, an attacker can make all requests at the boundary (e.g., at 59 seconds into a 60-second window), then make more at 1 second into the next window, doubling the effective rate for 2 seconds.
- **How to solve:** Implement sliding-window rate limiting in Redis using sorted sets with timestamps, or use a library like `express-rate-limit` with the `store` option pointing to Redis.

### Adaptive rate limit may over-throttle legitimate traffic

- **Where:** src/middleware/adaptiveRateLimit.ts (not reviewed; assuming exists)
- **Language:** TypeScript
- **Problem:** Adaptive rate limiting can react too aggressively to traffic spikes, potentially blocking legitimate users if a few requests spike (e.g., a sale or promotion).
- **How to solve:** Implement a gradual backoff policy instead of binary allow/block: reduce the allowance by 10% per spike event, resetting after a cool-down period.

### Rate limit headers sent but not trusted by client

- **Where:** src/middleware/rateLimit.ts:1200 (setStandardRateLimitHeaders)
- **Language:** TypeScript
- **Problem:** The middleware sets `X-RateLimit-*` and `RateLimit-*` headers, but clients must voluntarily back off. Without server-side enforcement (circuit breaker on client side), clients can ignore the headers and continue spamming.
- **How to solve:** This is expected behavior; ensure documentation warns clients that exceeding limits will result in 429 responses. Implement server-side circuit-breaker logic that temporarily blocks repeated offenders.

## Callbacks & Webhooks

### Callback idempotency store uses in-process memory (not distributed)

- **Where:** src/middleware/callbackIdempotency.ts:15-20 (CallbackIdempotencyStore with Map)
- **Language:** TypeScript
- **Problem:** The idempotency store is a plain `Map` in memory, not persisted to Redis or a database. If the process crashes, all idempotency state is lost, and replayed callbacks will be processed multiple times. Also, across multiple instances, each will have its own Map, and a callback could be processed twice (once per instance).
- **How to solve:** Persist idempotency records to Redis or the database with a 24-hour TTL, and query the persistent store before processing each callback.

### Callback idempotency based on hash, not atomic check

- **Where:** src/middleware/callbackIdempotency.ts:40-55 (findDuplicate)
- **Language:** TypeScript
- **Problem:** The `findDuplicate()` method checks if a callback hash matches an existing one, but the lookup and mark-as-duplicate are not atomic. Between the lookup and the subsequent processing, another identical callback could arrive and both could be processed.
- **How to solve:** Use a database INSERT with UNIQUE constraint on (provider, payloadHash), letting the database enforce atomicity. The first insert succeeds (idempotency claimed); subsequent inserts fail with a duplicate-key error.

### No signature verification on provider callbacks

- **Where:** src/services/providerCallbackSignatureService.ts (exists but signature verification not called in middleware)
- **Language:** TypeScript
- **Problem:** The `ProviderCallbackSignatureService` is defined but there is no middleware that calls it for every provider callback (mtn, airtel, orange). Without verification, an attacker could forge a callback claiming a payment succeeded when it did not.
- **How to solve:** Add signature verification to the callback middlewares for each provider, comparing the request signature against the active key version, and rejecting any callback with an invalid or missing signature.

### Signature verification grace period allows expired keys

- **Where:** src/services/providerCallbackSignatureService.ts:54-57 (rotateSignature sets ROTATING status)
- **Language:** TypeScript
- **Problem:** During key rotation, the old key is marked ROTATING and remains valid for the grace period (24-48 hours). If a key is compromised, an attacker can forge callbacks for up to 24 hours after the key rotation is initiated, because the old key is still accepted.
- **How to solve:** Reduce the grace period to 1-2 hours, or immediately revoke the old key upon rotation and require provider to update their signing key synchronously (accept brief callback delivery failures during rotation).

### Webhook circuit breaker state lost on restart

- **Where:** src/services/webhookCircuitBreaker.ts (lines 1-50, state is in-process)
- **Language:** TypeScript
- **Problem:** The comment at line 42-43 states "Breaker state is deliberately in-process", but this means after a deploy, all breakers reset to closed state, and a dead endpoint gets re-probed immediately, wasting resources and delaying failover until the next failure.
- **How to solve:** Persist breaker state to Redis with a 7-day TTL, so state survives restarts and new instances inherit the health status of dead endpoints.

### Webhook retry policy does not implement exponential backoff cap

- **Where:** src/services/webhookRetryPolicyService.ts (not fully reviewed; assuming exponential backoff without cap)
- **Language:** TypeScript
- **Problem:** If exponential backoff is implemented without a maximum delay cap, a webhook that fails might retry with a delay of 2^10 = 1024 seconds (17 minutes), causing important notifications to be delayed excessively.
- **How to solve:** Implement exponential backoff with a cap: `delay = Math.min(baseDelay * 2^attempt, maxDelay)`, e.g., capping at 5 minutes.

### Webhook delivery not idempotent on the receiver side

- **Where:** src/services/webhook.ts (delivery logic, not reviewed in detail)
- **Language:** TypeScript
- **Problem:** The service retries webhook delivery, but does not require the receiver (merchant endpoint) to be idempotent. If a webhook succeeds but the response is lost, the retry will deliver it twice, and the merchant might process the transaction twice if they don't implement their own idempotency.
- **How to solve:** Send an `Idempotency-Key` header with every webhook delivery (same key for retries), and document that merchants must accept any request with the same key as idempotent.

### No timeout on webhook delivery requests

- **Where:** src/services/webhook.ts (HTTP request code, not reviewed)
- **Language:** TypeScript
- **Problem:** Webhook delivery likely uses axios without a timeout, so if a merchant endpoint hangs, the entire transaction processing could stall, waiting for the response.
- **How to solve:** Set a timeout on webhook HTTP requests, e.g., `axios.post(..., { timeout: 5000 })`, and consider the request failed if it times out.

### Webhook payload not validated against schema before sending

- **Where:** src/services/webhookSchema.ts (minimal content), src/services/webhook.ts
- **Language:** TypeScript
- **Problem:** Webhook payloads are sent without schema validation on the sender side. If a bug in the service constructs an invalid payload, merchants receive malformed JSON and may process it incorrectly or error out silently.
- **How to solve:** Before sending each webhook, validate the payload against a JSON schema. Log validation errors and consider such errors non-fatal (send the webhook anyway if it's structurally valid, but log the validation warning).

## Provider Integration

### MTN provider hardcoded to sandbox environment

- **Where:** src/services/mobilemoney/providers/mtn.ts:32 (baseUrl initialization)
- **Language:** TypeScript
- **Problem:** Line 32: `this.baseUrl = "https://sandbox.momodeveloper.mtn.com"; ... if (process.env.MTN_BASE_URL) { this.baseUrl = process.env.MTN_BASE_URL; }` — the default is sandbox, and production config is only applied if the env var is set. This means production deployments without the env var accidentally use sandbox, routing live payments to a test environment.
- **How to solve:** Make the base URL explicit: `const env = process.env.NODE_ENV === 'production' ? 'production' : 'sandbox'; this.baseUrl = process.env.MTN_BASE_URL || \`https://\${env}.momodeveloper.mtn.com\``.

### MTN hardcoded currency EUR instead of using merchant's currency

- **Where:** src/services/mobilemoney/providers/mtn.ts:131-134 (requestPayment)
- **Language:** TypeScript
- **Problem:** Line 133: `currency: "EUR",` is hardcoded, not read from the request payload. A merchant in Cameroon (using XAF) would send a request with currency XAF, but the MTN provider would send EUR to MTN, causing a mismatch or rejection.
- **How to solve:** Pass currency from the request: `currency: payload.currency || "EUR"` (with EUR as fallback), or require currency in the payload and validate against the merchant's allowed currencies.

### No access token caching for provider requests

- **Where:** src/services/mobilemoney/providers/mtn.ts:38-52 (getAccessToken)
- **Language:** TypeScript
- **Problem:** Every call to `getOperationalBalance()` or `requestPayment()` first calls `getAccessToken()`, which makes a sync HTTP request to MTN. If 100 concurrent payments are initiated, 100 token requests are made. MTN likely rate-limits token requests, so this causes failures and latency.
- **How to solve:** Cache the access token in Redis with a TTL of 55 minutes (assuming 60-minute token lifetime), returning the cached token if it exists and hasn't expired.

### Provider balance check uses parseFloat, losing precision

- **Where:** src/services/mobilemoney/providers/mtn.ts:106
- **Language:** TypeScript
- **Problem:** Line 106: `const availableBalance = typeof availableRaw === "number" ? availableRaw : Number.parseFloat(String(availableRaw));` — the balance is parsed as a float, losing precision for large balances. A balance of 999999.999999999 will be rounded incorrectly.
- **How to solve:** Keep the balance as a string internally, or use a BigDecimal library. Only convert to a number when displaying, not when storing or comparing.

### No exponential backoff on provider API failures

- **Where:** src/services/mobilemoney/ (providers and mobileMoneyService, not fully reviewed)
- **Language:** TypeScript
- **Problem:** Provider requests likely have a simple retry loop without exponential backoff. If a provider is experiencing an outage, repeated immediate retries flood the provider with requests, making the outage worse.
- **How to solve:** Implement exponential backoff in a central retry utility: `delay = Math.min(100 * 2^attempt, 10000)` milliseconds between retries.

### Provider error handling does not distinguish transient vs permanent errors

- **Where:** src/services/providerErrorMap.ts (not fully reviewed)
- **Language:** TypeScript
- **Problem:** If a provider returns a 400 (bad request) and the service retries, the retry will fail identically. Permanent errors (bad request, auth failure) should not be retried; only transient errors (timeout, 503) should be.
- **How to solve:** Implement error classification: 4xx errors are permanent (don't retry), 5xx and timeouts are transient (retry with backoff), and categorize known provider errors accordingly.

### Provider balance reserve calculation not atomic

- **Where:** src/services/providerBalanceReserve.ts (not fully reviewed; assuming it reads balance then updates reserve)
- **Language:** TypeScript
- **Problem:** The balance reserve service likely reads the current balance, subtracts a reserve, and stores it. Concurrent operations could read the same balance, calculate reserves independently, and over-reserve, leaving insufficient funds for actual payouts.
- **How to solve:** Implement balance reserve as a single SQL operation: `UPDATE provider_balance SET reserved = reserved + amount WHERE available >= amount` (with a transaction to ensure atomicity).

### Provider health aggregation interval too long

- **Where:** src/services/providerHealthAggregationService.ts (not fully reviewed; likely has a polling interval)
- **Language:** TypeScript
- **Problem:** If the health check runs every 5 minutes, a provider outage might not be detected for up to 5 minutes, causing payments to be routed to a down provider and fail before failover occurs.
- **How to solve:** Reduce the health check interval to 30-60 seconds, and implement immediate failover on-error (mark provider as degraded immediately when a request fails, before waiting for the next scheduled check).

### Provider schema changes not backward compatible

- **Where:** src/services/providerSchemaMonitorService.ts (not fully reviewed)
- **Language:** TypeScript
- **Problem:** If a provider changes their API response schema (adds a required field, renames a field), the service code might break immediately if the schema validation is strict. There's likely no grace period or version negotiation.
- **How to solve:** Implement API version negotiation: query the provider's schema version endpoint before making requests, map responses through an adapter, and support multiple schema versions simultaneously during transitions.

### No retry on provider network timeout

- **Where:** src/services/mobilemoney/providers/mtn.ts (axios requests, no timeout shown)
- **Language:** TypeScript
- **Problem:** MTN provider makes HTTP requests without explicit timeout. If a request hangs (e.g., due to a network partition), the request could wait indefinitely (browser/axios default timeout is very long or unlimited), stalling transaction processing.
- **How to solve:** Set axios timeout: `axios.post(..., { timeout: 10000 })` for all provider requests, and retry transient failures.

### Provider configuration stored insecurely in environment

- **Where:** src/services/mobilemoney/providers/mtn.ts:27-31 (constructor reads env vars directly)
- **Language:** TypeScript
- **Problem:** Provider credentials (API key, secret, subscription key) are read from environment variables and stored in the object. If an error is logged or the object is serialized (e.g., in error reporting), credentials could leak.
- **How to solve:** Store credentials only in process.env, fetching them on demand (not storing in object fields). Mask credentials in logs using the `maskPII()` utility (which is already used on line 117).

## Database & Concurrency

### Replica lag fallback check happens after query execution

- **Where:** src/database/connection.ts:34-57 (shouldFallbackToPrimary is async)
- **Language:** TypeScript
- **Problem:** The `query()` function at line 101 calls `shouldFallbackToPrimary()` to decide which pool to use, but this check is async and happens before the query. If a critical read returns stale data from the replica, by the time we detect the lag and fail over, it's too late — the stale data was already used.
- **How to solve:** Implement a hybrid approach: always query the replica first for critical reads, then check lag asynchronously in the background. If lag exceeds threshold, the next request will use primary. For consistent reads, use serializable transactions.

### No connection pool size configuration

- **Where:** src/database/connection.ts:76-81 (primaryPool and replicaPool creation)
- **Language:** TypeScript
- **Problem:** The database connection pools are created without explicit size limits. If the default pool size is too small, connection exhaustion could cause request timeouts under high load.
- **How to solve:** Set explicit pool size: `new Pool({ ...databaseConfig, max: 20, min: 5 })` and configure these values via environment variables.

### No connection idle timeout configured

- **Where:** src/database/connection.ts:76-81
- **Language:** TypeScript
- **Problem:** Database connections are kept open indefinitely if idle. This can exhaust database connections over time as idle connections accumulate.
- **How to solve:** Set `idleTimeoutMillis: 30000` on the pool to close connections after 30 seconds of inactivity.

### Error on primary pool not triggering read-replica failover

- **Where:** src/database/connection.ts:87-94 (primaryPool error handler)
- **Language:** TypeScript
- **Problem:** When the primary database is down, the error handler logs the error but the application continues to try writing to the down primary, causing cascading failures.
- **How to solve:** Implement a circuit breaker: if the primary has N consecutive failures, temporarily route all queries to replica (accepting stale reads), and periodically probe the primary to detect recovery.

### Transaction isolation level not explicitly set

- **Where:** src/services/transactionService.ts:63 (BEGIN statement without ISOLATION LEVEL)
- **Language:** TypeScript
- **Problem:** PostgreSQL defaults to READ_COMMITTED isolation. Concurrent transactions can see dirty reads of uncommitted data. For financial transactions, READ_UNCOMMITTED or even SERIALIZABLE may be required.
- **How to solve:** Start transactions with explicit isolation: `await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE")` for critical operations, documenting why each isolation level is chosen.

### Client connection not released on error

- **Where:** src/services/transactionService.ts:82-108 (withdraw method finally block)
- **Language:** TypeScript
- **Problem:** The finally block at line 105 calls `client.release()`, but if an error is thrown between `client.query("BEGIN")` and this finally block, the transaction is automatically rolled back, but the client might not be released if an error occurs during the release itself.
- **How to solve:** Wrap the finally block: `finally { try { await client.query("ROLLBACK"); } catch {}; client.release(); }` to ensure release happens even if rollback fails.

### No prepared statement caching for repeated queries

- **Where:** Throughout codebase (all pool.query calls)
- **Language:** TypeScript
- **Problem:** Every query creates a new prepared statement. For high-throughput operations, the query parsing and planning overhead adds up, reducing throughput.
- **How to solve:** Cache prepared statements for repeated queries, or use a query builder/ORM that handles caching automatically (e.g., sequelize, typeorm).

## Input Validation & Security

### No maximum length validation on string inputs

- **Where:** Throughout routes (e.g., src/routes/transactions.ts, src/routes/users.ts)
- **Language:** TypeScript
- **Problem:** Request bodies accept strings without maximum length validation. An attacker could send a 1MB description field, causing memory exhaustion or slow queries if the field is indexed.
- **How to solve:** Add max-length validation in the schema: `description: z.string().max(500)` for all string fields, with reasonable limits based on the field's purpose.

### Phone number validation not strict enough

- **Where:** src/services/mobilemoney/providers/mtn.ts:117 (maskPII uses phone number)
- **Language:** TypeScript
- **Problem:** Phone numbers are accepted without format validation. A provider API might reject malformed numbers (e.g., "abc123"), but the ProxyPay service would have already stored the invalid number and created a transaction record, causing downstream confusion.
- **How to solve:** Validate phone numbers against a schema: `phoneNumber: z.string().regex(/^\+?[1-9]\d{1,14}$/)` (E.164 format) or use a library like `libphonenumber-js`.

### No rejection of oversized file uploads

- **Where:** src/middleware/upload.ts (not fully reviewed)
- **Language:** TypeScript
- **Problem:** If file upload middleware does not enforce a maximum size, an attacker could upload large files, exhausting disk space or causing out-of-memory errors.
- **How to solve:** Set `limits: { fileSize: 10 * 1024 * 1024 }` (10MB) in the multer configuration, rejecting files larger than this.

### SQL injection risk via unescaped string concatenation (need to verify)

- **Where:** Various locations (but likely mitigated by using parameterized queries)
- **Language:** TypeScript
- **Problem:** If any code uses string concatenation to build SQL (e.g., `\`SELECT \* FROM users WHERE id = ${userId}\``), it's vulnerable to SQL injection. The codebase seems to use parameterized queries consistently, but this should be verified.
- **How to solve:** Audit all database query code to ensure parameterized queries are used everywhere. Use a linter rule to prevent string interpolation in SQL queries.

### No JSON schema validation on all request bodies

- **Where:** Throughout routes (especially src/routes/ directory)
- **Language:** TypeScript
- **Problem:** Routes accept request bodies without validating against a schema. An attacker could send unexpected fields or fields with wrong types, potentially bypassing business logic or causing runtime errors.
- **How to solve:** Use a schema validation library (zod, joi, ajv) to validate all request bodies against a strict schema, rejecting requests with unexpected fields or types.

## Logging & Observability

### Sensitive data logged in info/debug levels

- **Where:** src/services/mobilemoney/providers/mtn.ts:117 (maskPII applied but other logs may not use it)
- **Language:** TypeScript
- **Problem:** The service logs payment details including phone numbers. If log level is set to DEBUG in production, sensitive user data could be exposed in logs or log aggregation services.
- **How to solve:** Always use `maskPII()` when logging user data, and ensure log level is WARN or higher in production.

### No request/response logging for compliance

- **Where:** src/middleware/logger.ts (not fully reviewed)
- **Language:** TypeScript
- **Problem:** Financial transactions should be logged with request/response details for compliance auditing. If logging is incomplete, regulatory audits could fail.
- **How to solve:** Add middleware to log all payment/transaction requests and responses (with PII masked), including timestamp, user ID, amount, and status.

### Error logging does not include stack traces

- **Where:** Throughout the codebase (logger calls)
- **Language:** TypeScript
- **Problem:** Error logging often does not include the full stack trace, making it hard to debug issues in production. For example, `logger.error(error)` without the stack can be unclear.
- **How to solve:** Log error object fully: `logger.error({ error, stack: error.stack, ...context }, 'Error occurred')`.

## Testing & Deployment

### No integration tests for transaction atomicity

- **Where:** src/services/**tests**/ (tests may not cover race conditions)
- **Language:** TypeScript
- **Problem:** Unit tests for withdraw may pass, but concurrent integration tests might reveal race conditions that unit tests miss. Without testing, TOCTOU races could go undetected.
- **How to solve:** Add integration tests that spawn multiple concurrent transactions and verify that balances remain consistent, ledgers balance, and no double-spends occur.

### No chaos engineering tests for provider failures

- **Where:** src/services/mobilemoney/providers/chaos.ts exists but may not be used in tests
- **Language:** TypeScript
- **Problem:** The chaos provider exists but there's no evidence that integration tests use it to simulate provider outages. Without such tests, failover logic could be broken and undetected.
- **How to solve:** Use the chaos provider in integration tests to simulate various provider failure modes (timeout, error response, partial failure) and verify the system's response.

### No load tests for database connection pooling

- **Where:** tests/ directory (load tests may not check connection pool behavior)
- **Language:** TypeScript
- **Problem:** Load tests might measure throughput but not connection pool saturation. Under load, connection exhaustion could cause failures that aren't caught until production.
- **How to solve:** Add load test scenarios that verify connection pool metrics (active connections, waiting connections, timeouts) stay within expected ranges, alerting if pools are exhausted.

### No rollback tests for failed migrations

- **Where:** migrations/ directory and tests/ (rollback tests may be missing)
- **Language:** SQL / TypeScript
- **Problem:** Migrations have `.down.sql` files but there's no automated testing to verify that rollbacks work. A failed rollback could leave the database in an inconsistent state during a recovery situation.
- **How to solve:** Add a migration test suite that runs each migration up, then down, then up again, verifying the schema is identical to the original.

## Environment & Configuration

### No secrets rotation schedule

- **Where:** src/config/ (likely env-based secrets loading)
- **Language:** TypeScript
- **Problem:** Secrets (API keys, database passwords, JWT signing keys) are loaded from environment at startup. If a secret is compromised, there's no automated rotation, and a manual rotation requires a redeploy.
- **How to solve:** Implement automated secret rotation: store secrets in a secret manager (AWS Secrets Manager, HashiCorp Vault), and rotate them on a schedule (e.g., 90 days), with the application reloading secrets periodically without restarting.

### No differentiation between dev and production config

- **Where:** src/config/configurations/ (if different env files exist) and src/index.ts startup
- **Language:** TypeScript
- **Problem:** If the same configuration is used for dev and production (e.g., same rate limits, fee configs), production could have overly permissive or overly strict settings.
- **How to solve:** Create separate configuration files for dev, staging, and production, with production configs being more restrictive (higher security, lower rate limits on sensitive operations).

### JWT signing key not rotated regularly

- **Where:** src/auth/jwt.ts:63-80 (buildKeyStore function)
- **Language:** TypeScript
- **Problem:** The JWT signing key is read from JWT_SECRET env var at startup and never rotated unless the app is restarted with a new env var. If the key is leaked, all tokens issued with that key are compromised.
- **How to solve:** Implement automatic key rotation: generate a new signing key every N days (e.g., 90 days), store it in the database, and load the active key at startup. Keep previous keys for verification during the grace period.

### Database password stored in environment variable

- **Where:** src/config/database.ts or similar (database URL/password loading)
- **Language:** TypeScript
- **Problem:** Database credentials are stored in environment variables, which can be exposed if the environment is accidentally logged, dumped, or shared.
- **How to solve:** Store database credentials in a secret manager and load them at runtime. Alternatively, use IAM-based authentication (e.g., AWS RDS IAM auth) instead of passwords.

### No feature flag configuration for gradual rollouts

- **Where:** src/config/ (feature flags may not be configured)
- **Language:** TypeScript
- **Problem:** Code changes are deployed all-at-once, with no gradual rollout or kill switch. If a bug is introduced, it affects all users immediately.
- **How to solve:** Implement feature flags (stored in Redis or database) to enable/disable features per user, region, or percentage, allowing gradual rollouts and quick kills.

### No environment variable validation at startup

- **Where:** src/index.ts or startup code
- **Language:** TypeScript
- **Problem:** If a required environment variable is missing, the application might start anyway (using a default), causing cryptic errors later when the variable is accessed.
- **How to solve:** Add startup validation: check that all required env vars are set, and exit with a clear error message if any are missing.

## Additional Real Backend Issues

### Race condition in concurrent transaction status updates

- **Where:** src/services/transactionStatusWorkflowService.ts (assumed location)
- **Language:** TypeScript
- **Problem:** Multiple concurrent requests can update transaction status without mutual exclusion, causing status transitions to race. A transaction marked "completed" by one request could be simultaneously marked "failed" by another, leaving the database in an inconsistent state with unclear final status.
- **How to solve:** Use a distributed lock (Redis SET NX) or database row-level lock with optimistic versioning (include version in WHERE clause).

### Missing validation on transaction amount bounds

- **Where:** src/routes/transactions.ts (transaction creation endpoints)
- **Language:** TypeScript
- **Problem:** Transaction amounts are not validated for upper bounds. An attacker could submit a transfer for 999999999999999 (or larger), potentially causing overflow issues or bypassing business logic limits.
- **How to solve:** Add validation: `if (amount > MAX_TRANSACTION_AMOUNT) throw new Error(...)` with a configurable max amount (e.g., 10 million in smallest unit).

### Provider API version mismatch not handled gracefully

- **Where:** src/services/mobilemoney/versioning/ (version adapter code)
- **Language:** TypeScript
- **Problem:** If a provider updates their API and returns a response with a new schema, the version adapter might silently fail to transform it, causing the service to return incomplete or incorrect data to callers.
- **How to solve:** Log version mismatches as errors, implement graceful degradation with fallback fields, and alert ops when a provider API version is not recognized.

### Concurrent merchant onboarding creates duplicate accounts

- **Where:** src/services/merchantOnboarding.ts
- **Language:** TypeScript
- **Problem:** If two requests arrive simultaneously for the same merchant email, both pass the uniqueness check before either inserts, causing duplicate accounts to be created or a database constraint violation that isn't handled gracefully.
- **How to solve:** Use a unique constraint on the email column and handle duplicate-key errors with a 409 Conflict response, or use database row-locking before checking existence.

### Fee audit log does not record which config was used

- **Where:** src/services/feeAuditService.ts
- **Language:** TypeScript
- **Problem:** When fees are calculated and logged, the audit entry does not record which fee configuration ID was used. A transaction's fee cannot be traced back to the configuration that produced it, making regulatory audits difficult.
- **How to solve:** Include the fee configuration ID and version in every fee audit entry, creating a durable link between transaction and config.

### Dispute evidence upload has no size limit

- **Where:** src/middleware/disputeUpload.ts or src/services/disputeS3Upload.ts
- **Language:** TypeScript
- **Problem:** Dispute evidence files (documents, images) are uploaded without a maximum file size check. An attacker could upload 1GB files repeatedly, exhausting storage and causing service degradation.
- **How to solve:** Set a maximum file size (e.g., 50MB per file, 500MB per dispute) and reject files larger than this limit with a 413 Payload Too Large response.

### Merchant webhook URL not validated for DNS/IP blacklist

- **Where:** src/services/merchantWebhookService.ts
- **Language:** TypeScript
- **Problem:** When a merchant provides a webhook URL, it is not validated to prevent SSRF (Server-Side Request Forgery) attacks. A merchant could register a webhook pointing to internal infrastructure (e.g., http://169.254.169.254/latest/meta-data) or localhost, causing the service to make unintended requests.
- **How to solve:** Validate webhook URLs: reject private IPs (10.0.0.0/8, 127.0.0.0/8, 172.16.0.0/12), localhost, and metadata endpoints; optionally resolve DNS and validate the resolved IP.

### No timeout on database query operations

- **Where:** src/config/database.ts or src/database/connection.ts
- **Language:** TypeScript
- **Problem:** Database queries have no query timeout set. A slow or hung query could block the entire connection pool, causing cascading failures across the application.
- **How to solve:** Set `statement_timeout` in PostgreSQL (e.g., 30 seconds for most queries, 5 minutes for batch operations) and configure pool query timeout in application code.

### Concurrent KYC tier upgrade allows overprivileging

- **Where:** src/services/kycTierUpgradeService.ts
- **Language:** TypeScript
- **Problem:** If two KYC approvals arrive for the same user simultaneously, both could pass the tier-check and apply an upgrade, causing the user's tier to be calculated incorrectly or jump multiple tiers.
- **How to solve:** Use a row-level lock or unique constraint on (user_id, approval_id) before applying tier changes.

### Payment link expiration stored but not enforced

- **Where:** src/services/ (payment link service) and routes (payment link routes)
- **Language:** TypeScript
- **Problem:** Payment links have an expiration timestamp but the expiration is not checked at payment-initiation time. An attacker could pay a link that expired years ago, and the transaction would be accepted.
- **How to solve:** Check expiration before accepting payment: `if (new Date() > paymentLink.expiresAt) throw new Error("Payment link expired")`.

### Split payment distribution not atomic

- **Where:** src/services/splitPaymentService.ts
- **Language:** TypeScript
- **Problem:** When splitting a payment across multiple recipients, if one recipient's account is locked mid-split, some recipients receive funds while others don't, violating the "all-or-nothing" principle of payments.
- **How to solve:** Implement the entire split distribution inside a database transaction with `SERIALIZABLE` isolation, rolling back all updates if any recipient's update fails.

### Transaction metadata can be updated after transaction finalization

- **Where:** src/services/transactionMetadataService.ts or routes that allow metadata PATCH
- **Language:** TypeScript
- **Problem:** Transaction metadata (notes, tags, categories) can be updated even after the transaction is marked "completed" or "failed". An attacker could alter metadata to change the audit trail or misrepresent the transaction.
- **How to solve:** Prevent metadata updates on terminal transactions: `if (TERMINAL_STATUSES.includes(transaction.status)) throw new Error("Cannot modify completed transaction")`.

### No rate limit on transaction search/filter endpoints

- **Where:** src/routes/transactionFilters.ts or src/routes/transactions.ts (search/filter methods)
- **Language:** TypeScript
- **Problem:** Transaction search/filter endpoints have no rate limit. An attacker could issue thousands of complex search queries, exhausting database resources and causing a denial of service.
- **How to solve:** Add rate limiting specific to search endpoints: e.g., 20 search queries per minute per user.

### Cached exchange rates not refreshed on stale data

- **Where:** src/services/exchangeRateBufferService.ts
- **Language:** TypeScript
- **Problem:** Exchange rates are cached but if the cache entry's TTL expires while the rate-fetching endpoint is down, the cache returns stale rates without refreshing. A user could execute a transaction at a rate that is hours old.
- **How to solve:** Implement cache with a "soft expiry" (warn if stale) and "hard expiry" (error if too stale, e.g., > 1 hour), and refresh in the background when approaching hard expiry.

### Concurrent account merge does not prevent transactions mid-merge

- **Where:** src/services/accountMergeDryRun.ts or the account merge service
- **Language:** TypeScript
- **Problem:** During account merge, if a transaction is initiated on the account being merged, it might be processed against the old account after the merge completes, causing data inconsistency.
- **How to solve:** Set an account status to "merging" before merge starts, rejecting new transactions, and revert to active only after merge completes.

### No backpressure on notification queue

- **Where:** src/queue/ or src/workers/notificationWorker.ts
- **Language:** TypeScript
- **Problem:** Notifications are enqueued without any check on queue depth. If the notification service is slow, the queue grows unbounded, exhausting memory.
- **How to solve:** Implement queue depth monitoring and either drop low-priority notifications or apply backpressure (reject new enqueues) if queue depth exceeds a threshold.

### Accounting sync errors are not retried with exponential backoff

- **Where:** src/services/accounting.ts or src/jobs/accountingSyncJob.ts
- **Language:** TypeScript
- **Problem:** If an accounting sync fails, the retry logic uses a fixed delay or no retry at all. If the downstream accounting system is temporarily down, the errors pile up without recovery.
- **How to solve:** Implement exponential backoff for sync retries, with a max delay cap and jitter to prevent thundering herd.

### No circuit breaker on sanction list updates

- **Where:** src/services/sanctionsSync.ts
- **Language:** TypeScript
- **Problem:** Sanction list updates (daily cron job) have no circuit breaker. If the sanction list provider is experiencing an outage, the job fails repeatedly, wasting resources.
- **How to solve:** Implement a circuit breaker that opens after 3 consecutive failures, and alert ops. Allow manual reset or automatic half-open state after 1 hour.

### Transaction reversal ledger entries not marked as reversals

- **Where:** src/services/ledgerService.ts (postReversal method) or src/services/transactionReversalService.ts
- **Language:** TypeScript
- **Problem:** When a reversal is posted to the ledger, it is recorded as regular entries without flagging them as reversals. Auditors cannot distinguish between normal transactions and reversals, complicating compliance.
- **How to solve:** Add a `reversal_id` and `is_reversal` flag to ledger entries, and ensure all reversal postings set these fields.

### No maximum nesting depth for dispute comments

- **Where:** src/services/dispute.ts or src/routes/disputes.ts (add note/comment endpoints)
- **Language:** TypeScript
- **Problem:** Dispute comments/notes can be nested arbitrarily deep. An attacker could create a comment thread 10,000 levels deep, consuming memory and making the UI unresponsive.
- **How to solve:** Enforce a maximum nesting depth (e.g., 5 levels) and reject comments that exceed it.

### Subscription renewal does not validate that account is still active

- **Where:** src/routes/subscriptions.ts or src/services/ (subscription renewal logic)
- **Language:** TypeScript
- **Problem:** A subscription can be renewed even if the account is suspended or frozen. The system charges a suspended account for a renewal, violating business rules.
- **How to solve:** Check account status before charging: `if (account.status !== 'active') throw new Error("Cannot renew subscription for inactive account")`.

### No validation that provider configuration is complete before routing

- **Where:** src/services/mobilemoney/providers/ (base provider or routing logic)
- **Language:** TypeScript
- **Problem:** A request is routed to a provider even if the provider's credentials are not configured (empty strings, nulls). The provider then fails with a cryptic error.
- **How to solve:** Validate provider configuration at startup: check that all required fields are set, and fail fast with a clear error message if not.

### Retry logic does not respect provider SLA

- **Where:** src/services/mobilemoney/ or src/queue/ (retry scheduling)
- **Language:** TypeScript
- **Problem:** A provider specifies an SLA (e.g., "complete within 1 hour") but the retry logic might exceed this by scheduling retries beyond the SLA window, causing transactions to fail after the promised window has passed.
- **How to solve:** Calculate the SLA deadline from transaction creation time, and stop retrying if the deadline has passed, marking the transaction as failed.

### No prevention of simultaneous invoice generation for same transaction

- **Where:** src/services/invoiceService.ts
- **Language:** TypeScript
- **Problem:** If two requests arrive to generate an invoice for the same transaction, both might create invoices, resulting in duplicate invoices with different content.
- **How to solve:** Use a unique constraint on (transaction_id, invoice_type) and handle duplicate-key errors gracefully.

### Receipt template rendering has no size limit on output

- **Where:** src/services/receiptTemplateService.ts
- **Language:** TypeScript
- **Problem:** When rendering a receipt template with user data, a large or malicious input (e.g., a 1MB merchant name) could cause the rendered receipt to be huge, consuming memory.
- **How to solve:** Validate template variables for reasonable sizes and truncate or reject oversized inputs.

### No validation of CSV format before importing

- **Where:** src/routes/ (likely bulk or import route) or src/services/ (CSV import service)
- **Language:** TypeScript
- **Problem:** CSV imports accept any file without validating the structure. A malformed CSV could cause parsing errors or silent data corruption if columns are in the wrong order.
- **How to solve:** Validate CSV headers and require specific columns in a specific order; reject CSVs with missing or extra columns.

### Duplicate transaction detection uses only amount, not timestamp

- **Where:** src/services/ (duplicate detection logic, possibly in fraud or transaction service)
- **Language:** TypeScript
- **Problem:** Duplicate transactions are detected by matching amount alone. Two identical legitimate transactions 5 minutes apart are incorrectly flagged as duplicates.
- **How to solve:** Use a composite key: (user_id, amount, provider, timestamp_range) where timestamp_range is a 5-minute window, not just amount.

### No lease/lock on failed job entries prevents concurrent retry

- **Where:** src/queue/ or src/jobs/ (job processing logic)
- **Language:** TypeScript
- **Problem:** When a job fails and is placed in a retry queue, another instance could pick up the same job and process it concurrently, causing duplicate work.
- **How to solve:** Use a distributed lock (Redis GETEX with EXAT) to ensure only one instance processes a given job at a time.

### Transaction search full-text index not maintained

- **Where:** src/services/transactionFilterService.ts or database schema
- **Language:** TypeScript / SQL
- **Problem:** Transactions are searchable by full-text, but if new transactions are inserted without updating the full-text index, they won't be found by search queries.
- **How to solve:** Ensure full-text index is updated automatically via a database trigger, or refresh it in a background job.

### No transaction size limit for large transfers

- **Where:** src/routes/transactions.ts or src/services/transactionService.ts
- **Language:** TypeScript
- **Problem:** Transactions have no upper size limit. A request for a 1 trillion unit transfer is accepted, causing calculation overflow or hitting arbitrary database limits.
- **How to solve:** Validate transaction amount is within reasonable bounds: `if (amount > config.MAX_TRANSACTION_SIZE) throw new Error(...)`.

### Merchant settlement account not validated before use

- **Where:** src/services/merchantService.ts or settlement logic
- **Language:** TypeScript
- **Problem:** When settling funds to a merchant, the settlement account (bank details) are not re-validated. A merchant could update their settlement account to point to a fraudulent bank, and subsequent settlements go to the wrong place.
- **How to solve:** Validate settlement account details before using: check that the bank account exists, belongs to the merchant, and hasn't been recently changed without verification.

### No pagination on audit log queries

- **Where:** src/services/auditlogService.ts or routes that fetch audit logs
- **Language:** TypeScript
- **Problem:** Audit logs can be fetched without pagination limits. Querying a user with 10 million audit entries could crash the server due to memory exhaustion.
- **How to solve:** Enforce pagination with a default limit (e.g., 100) and max limit (e.g., 1000).

### Cryptocurrency price feed single point of failure

- **Where:** src/services/priceTicker.ts
- **Language:** TypeScript
- **Problem:** Price feeds are fetched from a single provider. If the provider is down, exchange rates are stale and transactions use outdated prices.
- **How to solve:** Implement multi-source price feeds with fallback logic, fetching from multiple providers and using the median price to reduce outlier risk.

### No validation of merchant tier before authorizing large transaction

- **Where:** src/services/merchantService.ts or transaction authorization logic
- **Language:** TypeScript
- **Problem:** A merchant with a "basic" tier (low limits) could initiate a high-value transaction, and the tier check might be skipped or bypassed.
- **How to solve:** Enforce tier limits on every transaction: `if (transaction.amount > merchant.tier.dailyLimit) throw new Error(...)`.

### Compliance document expiry not enforced

- **Where:** src/services/ (compliance or KYC service)
- **Language:** TypeScript
- **Problem:** Compliance documents (proof of address, ID) have expiry dates, but the system doesn't enforce them. An expired ID is still accepted for account operations.
- **How to solve:** Check document expiry before allowing regulated operations: `if (new Date() > document.expiresAt) throw new Error("Document expired")`.

### No back-pressure mechanism when provider is slow

- **Where:** src/services/mobilemoney/ or src/routes/ (transaction endpoints)
- **Language:** TypeScript
- **Problem:** If a provider is slow, requests to that provider are queued infinitely without dropping or rejecting new requests. The queue grows unbounded and the application eventually runs out of memory.
- **How to solve:** Implement a queue depth check and either reject new requests with a 503 Service Unavailable or drop low-priority requests from the queue.

### Fraud score recalculation does not account for time decay

- **Where:** src/services/fraud.ts or src/services/mlFraudDetectionService.ts
- **Language:** TypeScript
- **Problem:** Fraud heuristics (e.g., "velocity") count transactions from any time in the past year equally. An old transaction shouldn't count as much as a recent one when evaluating velocity.
- **How to solve:** Apply exponential time decay to historical transactions: weight = exp(-decay_rate \* days_ago).

### No validation of JSON structure before parsing

- **Where:** Throughout routes (when parsing request.body)
- **Language:** TypeScript
- **Problem:** Request bodies are parsed as JSON without schema validation. Unexpected nesting or field types can cause runtime errors or bypass business logic.
- **How to solve:** Use a schema validation library (zod, joi) to validate all request payloads before processing.

### User email change not validated to prevent takeover

- **Where:** src/services/userService.ts or src/routes/users.ts
- **Language:** TypeScript
- **Problem:** A user can change their email without verifying ownership of the new email. An attacker could change a user's email to attacker@example.com, take over the account via password reset.
- **How to solve:** Require email verification: send a verification link to the new email, and only apply the change after the link is clicked.

### No rate limit on password change requests

- **Where:** src/routes/users.ts or src/services/userService.ts
- **Language:** TypeScript
- **Problem:** Password can be changed repeatedly without rate limiting. An attacker could spam password change requests, triggering email alerts that annoy the user.
- **How to solve:** Rate limit password changes: e.g., 1 change per hour per user.

### Sensitive operation uses email verification instead of 2FA

- **Where:** src/middleware/twoFactor.ts or auth routes
- **Language:** TypeScript
- **Problem:** High-risk operations (withdrawal, payment link creation) only require email verification, not 2FA. Email is less secure than 2FA.
- **How to solve:** Require 2FA (TOTP, backup codes, etc.) for high-risk operations, not email.

### No monitoring of failed 2FA attempts

- **Where:** src/services/twoFactorService.ts
- **Language:** TypeScript
- **Problem:** Failed 2FA attempts are not tracked. An attacker could brute-force 2FA codes without alerting the user.
- **How to solve:** Track consecutive failed 2FA attempts and lock the account after N failures (e.g., 5), requiring manual unlock or a longer cooldown.

### Device fingerprint changes not alerted

- **Where:** src/middleware/fingerprint.ts or src/auth/
- **Language:** TypeScript
- **Problem:** When a user logs in from a new device or browser, there's no alert. An attacker could access the account from a new device without raising suspicion.
- **How to solve:** Send an email alert on new device logins: "Your account was accessed from a new device. If this wasn't you, change your password."

### Transaction reversal can be re-reversed indefinitely

- **Where:** src/services/transactionReversalService.ts
- **Language:** TypeScript
- **Problem:** A reversal transaction can itself be reversed, which can be reversed again. This creates an infinite loop of reversals and makes it unclear what the final transaction status is.
- **How to solve:** Prevent reversals of reversal transactions: `if (transaction.is_reversal) throw new Error("Cannot reverse a reversal")`.

### No idempotency on settlement posting

- **Where:** src/services/settlementStatus.ts or settlement logic
- **Language:** TypeScript
- **Problem:** A settlement can be posted to the ledger twice if the same settlement request is retried. The merchant receives double the settlement amount.
- **How to solve:** Implement idempotency using an idempotency key: store (settlement_id, idempotency_key) and return the same result if replayed.

### No validation that transfer amount matches invoice total

- **Where:** src/services/accounting.ts or src/routes/accounting.ts
- **Language:** TypeScript
- **Problem:** When posting a transfer, the service doesn't validate that the transfer amount matches the invoice or transaction total. An accidental or malicious mismatch could corrupt accounting records.
- **How to solve:** Assert amount consistency: `if (transfer.amount !== invoice.total) throw new Error("Transfer amount doesn't match invoice")`.

### No backup of critical configuration changes

- **Where:** src/services/ (fee config, provider settings, etc.)
- **Language:** TypeScript
- **Problem:** Critical configuration changes (fees, provider credentials, rate limits) are not backed up. If a config is corrupted, there's no way to recover it.
- **How to solve:** Store a backup of every config change in a separate table or S3 bucket with a 90-day retention policy.

### No detection of config drift between environments

- **Where:** src/config/
- **Language:** TypeScript
- **Problem:** Dev and production might have different configurations (different fees, rate limits), but there's no check to detect when they drift. A config might be correct in dev but wrong in prod.
- **How to solve:** At startup, compare deployed config against a reference config and alert if anything deviates beyond acceptable thresholds.

### No timeout on long-running background jobs

- **Where:** src/jobs/ (all job files)
- **Language:** TypeScript
- **Problem:** Background jobs have no timeout. A job that hangs or enters an infinite loop will consume resources until the process restarts or crashes.
- **How to solve:** Set a timeout on every job (e.g., 5 minutes for typical jobs, 1 hour for heavy jobs) and kill the job if it exceeds the timeout.

### Batch operations not rolled back atomically on partial failure

- **Where:** src/routes/batchOperations.ts or src/services/ (batch processing)
- **Language:** TypeScript
- **Problem:** When processing a batch (e.g., 100 payments), if payment #50 fails, payments #1-49 have already been posted. The batch is left in a half-completed state.
- **How to solve:** Wrap the entire batch in a database transaction and rollback on any error, ensuring all-or-nothing semantics.

### No deadlock detection on concurrent ledger writes

- **Where:** src/services/ledgerService.ts
- **Language:** TypeScript
- **Problem:** If two concurrent transactions try to post ledger entries in different orders, a database deadlock can occur. The application doesn't detect or handle this.
- **How to solve:** Implement deadlock retry logic: catch the deadlock error and retry the entire transaction with exponential backoff.

### No validation of crypto key version in use

- **Where:** src/crypto/ (key management and crypto operations)
- **Language:** TypeScript
- **Problem:** Encrypted data might have been encrypted with an old key that is now rotated out. When decrypting, the service might use the wrong key, returning garbage.
- **How to solve:** Store the key version/ID with every encrypted value, and use the correct key for decryption.

### No monitoring of PII access patterns

- **Where:** src/services/ (services that read PII) or middleware
- **Language:** TypeScript
- **Problem:** When a user's PII (phone number, address) is accessed, there's no log of who accessed it and why. A rogue employee could exfiltrate data without detection.
- **How to solve:** Log all PII access with the accessor, timestamp, and purpose; implement alerting for suspicious access patterns (e.g., large bulk reads).

### Transaction reconciliation does not detect out-of-order writes

- **Where:** src/services/ledgerReconciliation.ts or reconciliation logic
- **Language:** TypeScript
- **Problem:** Transactions are expected to be posted in order, but if a slow write completes late, a newer transaction might already be reconciled against an outdated state.
- **How to solve:** Use versioning or sequence numbers to detect out-of-order writes and alert ops.

### No alert on provider API quota exhaustion

- **Where:** src/services/mobilemoney/ (provider integration) or monitoring
- **Language:** TypeScript
- **Problem:** A provider might impose a daily quota (e.g., 10,000 requests/day), but the service doesn't track usage or alert when approaching the limit. The quota is silently hit mid-day, causing all subsequent requests to fail.
- **How to solve:** Track API quota usage and alert ops when usage reaches 80% of the daily limit.

### Notification delivery fails silently without alerting ops

- **Where:** src/workers/notificationWorker.ts or src/services/notificationRouter.ts
- **Language:** TypeScript
- **Problem:** If the notification delivery fails (email server down, SMS provider overloaded), the error is logged but ops are not alerted. Notifications are silently lost.
- **How to solve:** On notification delivery failure, send an alert to ops and store the failed notification in a DLQ for manual retry.

### No rate limit on export operations

- **Where:** src/routes/export.ts or export endpoints
- **Language:** TypeScript
- **Problem:** Exporting large datasets (all transactions, all users) has no rate limit. An attacker could request dozens of large exports, consuming CPU and I/O.
- **How to solve:** Rate limit export operations: e.g., 1 export per hour per user, with a max export size (e.g., 100,000 records).

### User consent not validated for compliance workflows

- **Where:** src/services/complianceTrainingService.ts or compliance routes
- **Language:** TypeScript
- **Problem:** Compliance workflows (e.g., mandatory training before withdrawal) can be bypassed if the user doesn't actually complete the training. The system doesn't verify that the user clicked through the training.
- **How to solve:** Require explicit user acknowledgment (checkboxes) for each compliance step and store acknowledgment timestamps.

### No prevention of duplicate compliance document uploads

- **Where:** src/routes/ (compliance or KYC document upload routes)
- **Language:** TypeScript
- **Problem:** A user can upload the same compliance document multiple times. The system accepts duplicates without deduplication, wasting storage and creating audit confusion.
- **How to solve:** Hash uploaded documents and reject duplicates: `if (documentHash in uploadedDocuments) throw new Error("Document already uploaded")`.

### Rate limit bypass via null/empty user ID

- **Where:** src/middleware/rateLimit.ts or src/middleware/authRateLimit.ts
- **Language:** TypeScript
- **Problem:** Rate limiting keys on `req.user?.id`, but if `user` is not attached (unauthenticated endpoint), the key becomes undefined or null, causing all unauthenticated users to share a single rate limit bucket.
- **How to solve:** Use IP + user ID composite key: `const key = req.user?.id ? \`user:\${req.user.id}\` : \`ip:\${req.ip}\``.

### No monitoring of transaction processing latency

- **Where:** src/routes/ (transaction routes) or middleware
- **Language:** TypeScript
- **Problem:** Transactions are processed but there's no metric tracking how long they take. Slow transactions go undetected, degrading user experience.
- **How to solve:** Add timing middleware that tracks request latency and publishes it as a metric (e.g., histogram).

### Concurrent deletion of linked resources doesn't prevent orphans

- **Where:** Various delete endpoints in routes
- **Language:** TypeScript
- **Problem:** When deleting a merchant, if a transaction is simultaneously being created for that merchant, the transaction creates an orphan (foreign key reference to deleted row).
- **How to solve:** Use database constraints: `ON DELETE RESTRICT` to prevent deletion of merchants with transactions, or implement cascade delete carefully within a transaction.

### No circuit breaker on notification delivery

- **Where:** src/services/notificationRouter.ts or src/workers/notificationWorker.ts
- **Language:** TypeScript
- **Problem:** If a notification service (email, SMS) is down, notifications are retried indefinitely, wasting resources. After 100 consecutive failures, the circuit breaker should open.
- **How to solve:** Implement exponential backoff and circuit breaker: open after N failures, half-open after cooldown, close after success.

### No validation of refund destination before refunding

- **Where:** src/services/ (refund logic) or routes
- **Language:** TypeScript
- **Problem:** When refunding a transaction, the destination account is not re-validated. A user could have changed their account details, and the refund goes to the wrong place.
- **How to solve:** Validate refund destination matches the original transaction source, or require re-confirmation from the user before processing refund.

### Duplicate transaction filtering uses only hash, not timestamp

- **Where:** src/services/transactionService.ts or duplicate detection logic
- **Language:** TypeScript
- **Problem:** Duplicate detection hashes the transaction but ignores timestamp. Two identical transactions 5 years apart are incorrectly flagged as duplicates.
- **How to solve:** Include transaction timestamp in duplicate detection, flagging duplicates only within a reasonable window (e.g., 24 hours).

### No validation of audit log entry immutability

- **Where:** src/services/auditlogService.ts
- **Language:** TypeScript
- **Problem:** Audit log entries can be modified after creation (if the database allows updates), violating the immutability principle. An insider could alter audit logs to cover tracks.
- **How to solve:** Use a database table with constraints that prevent updates: `ALTER TABLE audit_log ADD CONSTRAINT audit_immutable CHECK (created_at <= NOW() AND updated_at = created_at)` or use append-only storage.

### No detection of session fixation attacks

- **Where:** src/auth/jwt.ts or session management
- **Language:** TypeScript
- **Problem:** An attacker could set a user's session ID to a known value, then trick the user into logging in with that session. The attacker then uses the known session ID to access the account.
- **How to solve:** Regenerate the session ID after successful login, invalidating any pre-set session ID.

### Provider error responses not consistently parsed

- **Where:** src/services/mobilemoney/providers/ (all provider files)
- **Language:** TypeScript
- **Problem:** Different providers return error responses in different formats. A provider error might not be correctly parsed, causing the service to treat it as success or unknown error.
- **How to solve:** Define error parsing per provider, with unit tests for each error format. Use a common error schema internally.

### No validation that webhook delivery completed before marking as delivered

- **Where:** src/services/webhook.ts
- **Language:** TypeScript
- **Problem:** A webhook might be marked as "delivered" before the HTTP request actually completes. If the request fails after the mark, the failure is lost.
- **How to solve:** Mark webhook as delivered only after receiving a successful (2xx) HTTP response and retries are exhausted.

### Refund transaction references original incorrectly

- **Where:** src/services/transactionReversalService.ts or refund logic
- **Language:** TypeScript
- **Problem:** When creating a refund transaction, the reference to the original transaction is not stored correctly. The refund is orphaned and can't be traced back.
- **How to solve:** Create a `refund_for` column in transactions table linking refunds to originals, with foreign key constraint.

### No monitoring of webhook delivery SLA

- **Where:** src/services/webhook.ts or monitoring
- **Language:** TypeScript
- **Problem:** Webhooks should be delivered within a reasonable SLA (e.g., 5 minutes), but there's no monitoring of delivery time. Some webhooks could take hours to deliver without alerting ops.
- **How to solve:** Track webhook delivery latency and alert if delivery exceeds SLA threshold.
