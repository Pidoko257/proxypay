# feat: enforce structured error response format (#108)

## Summary

Standardizes API error responses across the ProxyPay codebase. All error responses follow `{ code, message, details?, requestId }` with supporting fields `message_en`, `timestamp`, and `statusCode`. This PR fills the remaining gaps from the existing error handler infrastructure.

## Changes

### `src/constants/errorCodes.ts`
- Fixed `SERVICE_UNAVAILABLE` to return HTTP **503** (was incorrectly returning 500)

### `src/utils/errors.ts`
- Added `AuthError` as an exported alias for `AuthenticationError` for API compatibility

### `src/middleware/errorHandler.ts`
- Added explicit comment confirming `stack` is intentionally excluded from all response bodies (logged server-side only)

### `src/tests/customErrors.test.ts` (new)
- 17 unit tests covering all custom error classes: `ValidationError`, `NotFoundError`, `AuthenticationError`, `AuthError`, `AuthorizationError`, `ConflictError`, `BusinessLogicError`
- Tests verify: correct HTTP status code, correct error `code`, `{ code, message, timestamp }` fields present, `stack` absent from response in both production and development, `details` stripped in production, `requestId` forwarded from error object and request object

## Error Response Format

All error responses follow:
```json
{
  "code": "INVALID_INPUT",
  "message": "Invalid input provided",
  "message_en": "Invalid input provided",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "requestId": "req-abc-123",
  "details": { "field": "phoneNumber" }
}
```
`details` is omitted in production. `requestId` is omitted if not present.

## Custom Error Classes

| Class | Status | Code |
|---|---|---|
| `ValidationError` | 400 | `INVALID_INPUT` (configurable) |
| `AuthenticationError` / `AuthError` | 401 | `UNAUTHORIZED` |
| `AuthorizationError` | 403 | `FORBIDDEN` |
| `NotFoundError` | 404 | `NOT_FOUND` |
| `ConflictError` | 409 | `CONFLICT` |
| `BusinessLogicError` | varies | configurable |
| (generic 500) | 500 | `INTERNAL_ERROR` |
| (SERVICE_UNAVAILABLE) | 503 | `SERVICE_UNAVAILABLE` |

closes #108
