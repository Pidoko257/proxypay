# feat: implement mobile money callback signature verification (#105)

## Summary

Adds provider-specific callback signature verification for MTN MoMo and Airtel Money inbound webhook callbacks. Unverified callbacks are rejected with HTTP 403 and logged as security anomaly events.

## Changes

### MTN MoMo (`src/middleware/mtnCallbackSignature.ts`)
- Fixed response code: unverified callbacks now return **403 Forbidden** (was 401) per acceptance criteria
- HMAC-SHA256 verification using `MTN_CALLBACK_SECRET` (subscription key) on the `X-Callback-Signature` header
- Supports both `sha256=` prefixed hex and plain base64 signature formats
- Timing-safe comparison via `timingSafeEqual`
- All rejection paths log a `security.anomaly` event with reason code

### Airtel Money — new

| File | Description |
|---|---|
| `src/middleware/airtelCallbackSignature.ts` | New middleware — validates `Authorization: Bearer {token}` against `AIRTEL_CALLBACK_SECRET` using `timingSafeEqual`. Missing = 403. Invalid = 403. Unconfigured = 500. All failures logged as security anomalies. |
| `src/routes/airtelCallbacks.ts` | New router — `ingestRateLimiter` → `verifyAirtelCallbackSignature` → `POST /callback` → `{ status: "accepted" }` |
| `src/config/appConfig.ts` | Added `providers.airtel.callbackSecret` config entry (env: `AIRTEL_CALLBACK_SECRET`) |
| `src/index.ts` | Mounted Airtel callback router at `app.use("/api/airtel", airtelCallbacksRouter)` |

### Tests

| File | Tests |
|---|---|
| `src/middleware/__tests__/airtelCallbackSignature.test.ts` | 5 unit tests: unconfigured secret (500), missing header (403), non-Bearer scheme (403), valid token (200), wrong token (403) |
| `src/routes/__tests__/airtelCallbacks.test.ts` | 4 integration tests via supertest: valid bearer (200), missing auth (403), wrong token (403), Basic scheme (403) |
| `src/middleware/__tests__/mtnCallbackSignature.test.ts` | Updated — expect 403 instead of 401 |
| `src/routes/__tests__/mtnCallbacks.test.ts` | Updated — expect 403 instead of 401 |

## Environment Variables Required

```env
MTN_CALLBACK_SECRET=<mtn-subscription-key-or-hmac-secret>
AIRTEL_CALLBACK_SECRET=<airtel-shared-secret-token>
```

## Acceptance Criteria

- ✅ MTN MoMo callbacks validate `X-Callback-Signature` header using HMAC-SHA256 with subscription key
- ✅ Airtel callbacks validate `Authorization: Bearer` token against expected shared secret
- ✅ Unverified callbacks return 403 and are logged as security events
- ✅ Verification logic is unit tested with known valid and invalid signature vectors

closes #105
