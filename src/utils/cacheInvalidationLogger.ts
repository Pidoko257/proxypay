import logger from "./logger";

export type CacheInvalidationTrigger =
  | "kyc_level_update"
  | "apikey_change"
  | "fee_config_change"
  | "admin_flush";

export interface CacheInvalidationEvent {
  event: "cache_invalidated";
  key?: string;
  pattern?: string;
  trigger: CacheInvalidationTrigger;
  adminId?: string;
  timestamp: string;
}

export function logCacheInvalidation(event: CacheInvalidationEvent): void {
  logger.info(event, "cache_invalidated");
}
