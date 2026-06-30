# Per-Organization Feature Flag System

## Problem

ProxyPay needs to roll out new features to specific organizations before general availability. Without a feature flag system, enabling/disabling features requires code changes and deployments, making gradual rollouts and targeted testing impractical.

## Solution

Implement a feature flag system backed by PostgreSQL with Redis caching. Flags are stored per organization, cached in Redis with a 60-second TTL, and evaluated via Express middleware. An admin API enables/disables flags per organization without a deployment.

## Changes

### New Files

| File | Purpose |
|------|---------|
| `migrations/20260630_create_feature_flags_table.sql` | Creates `feature_flags` table with `organization_id`, `flag_name`, `enabled`, unique constraint, indexes, and auto-update trigger |
| `src/services/featureFlagService.ts` | Core service: reads from Redis cache (with DB fallback), writes to DB + Redis, supports TTL-based cache invalidation |
| `src/middleware/featureFlag.ts` | `requireFeature('flag_name')` middleware — resolves org from `req.user` or `req.jwtUser`, returns 403 on disabled flag |
| `src/routes/featureFlags.ts` | Admin CRUD routes: `GET /` (list by org), `PUT /:flagName` (upsert), `DELETE /:flagName` (remove) |

### Modified Files

| File | Change |
|------|--------|
| `src/constants/errorCodes.ts` | Added `FEATURE_NOT_ENABLED` error code (403) |
| `src/index.ts` | Added import and mount for feature flag admin routes at `/api/admin/feature-flags` |

## How It Works

1. **Storage**: `feature_flags` table stores `(organization_id, flag_name, enabled)` with a unique constraint on the pair.
2. **Caching**: On read, Redis key `feature_flag:{orgId}:{flagName}` is checked first (60s TTL). On cache miss, the DB is queried and the result is cached. Writes update both DB and Redis.
3. **Middleware**: `requireFeature('flag_name')` is an Express middleware factory. It resolves the requesting organization from `req.user.id` (admin API key) or `req.jwtUser.userId` (user JWT). If the flag is disabled, returns 403 with `ERR_FEATURE_NOT_ENABLED`.
4. **Admin API**:
   - `GET /api/admin/feature-flags?organizationId=<id>` — list all flags for an org
   - `PUT /api/admin/feature-flags/:flagName` — upsert a flag (`{ organizationId, enabled }`)
   - `DELETE /api/admin/feature-flags/:flagName` — delete a flag
5. **TTL**: Changes are reflected within 60 seconds (Redis cache TTL).

## Acceptance Criteria

- [x] `feature_flags` table stores flag name, organization_id, and enabled boolean
- [x] Middleware function `requireFeature('flag_name')` checks the flag for the requesting org
- [x] Disabled feature endpoints return 403 with `ERR_FEATURE_NOT_ENABLED`
- [x] Admin endpoint manages flags per organization; changes reflected within 60 seconds (Redis TTL)

## Usage Example

```typescript
import { requireFeature } from "../middleware/featureFlag";

router.get(
  "/beta-feature",
  requireFeature("beta_dashboard"),
  async (req, res) => {
    // Only accessible when org has beta_dashboard enabled
    res.json({ data: "beta feature" });
  },
);
```

```bash
# Enable a feature flag
curl -X PUT /api/admin/feature-flags/beta_dashboard \
  -H "X-API-Key: <admin-key>" \
  -d '{"organizationId": "org-uuid", "enabled": true}'
```

closes #114
