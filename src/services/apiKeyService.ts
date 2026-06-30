import { layeredCache } from "./layeredCache";
import { logCacheInvalidation } from "../utils/cacheInvalidationLogger";

/**
 * Cache key format for user API keys.
 * TTL: 600 seconds (10 minutes)
 * Invalidation: call invalidateApiKeyCache(userId) after any API key create/update/delete
 */
export const API_KEY_CACHE_KEY_PREFIX = "cache:apikeys:";

export async function invalidateApiKeyCache(userId: string): Promise<void> {
  const cacheKey = `${API_KEY_CACHE_KEY_PREFIX}${userId}`;
  try {
    await layeredCache.del(cacheKey);
    logCacheInvalidation({
      event: "cache_invalidated",
      key: cacheKey,
      trigger: "apikey_change",
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(`Failed to invalidate API key cache for user ${userId}:`, err);
  }
}
