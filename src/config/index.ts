/**
 * Configuration Module Index
 * 
 * This module re-exports all configuration utilities and must be imported
 * before any other modules that depend on configuration.
 */

// Initialize config system - must be imported first
import './init';
import { getConfigValue } from './appConfig';
import { PROVIDER_LIMITS, MobileMoneyProvider } from './providers';
import { TRANSACTION_LIMITS, KYCLevel } from './limits';

export { getConfig, getConfigValue } from './appConfig';
export { PROVIDER_LIMITS, getProviderLimitsConfig, MobileMoneyProvider } from './providers';
export { TRANSACTION_LIMITS, MIN_TRANSACTION_AMOUNT, MAX_TRANSACTION_AMOUNT, KYCLevel } from './limits';

// Helper functions for commonly accessed config values
export function getProviderLimit(provider: MobileMoneyProvider): { minAmount: number; maxAmount: number } | null {
  return PROVIDER_LIMITS[provider] || null;
}

export function getKycLimit(level: KYCLevel): number | null {
  return TRANSACTION_LIMITS[level] || null;
}

export function getTransactionConfig() {
  return {
    maxTags: getConfigValue('transactions.maxTags'),
    maxMetadataBytes: getConfigValue('transactions.maxMetadataBytes'),
    maxNotesLength: getConfigValue('transactions.maxNotesLength'),
    timeoutMinutes: getConfigValue('transactions.timeoutMinutes'),
    idempotencyKeyTtlHours: getConfigValue('transactions.idempotencyKeyTtlHours'),
  };
}

export function getCacheConfig() {
  return {
    geolocationTtlSeconds: getConfigValue('cache.geolocationTtlSeconds'),
    geolocationApiTimeoutMs: getConfigValue('cache.geolocationApiTimeoutMs'),
    healthCheckCacheTtlSeconds: getConfigValue('cache.healthCheckCacheTtlSeconds'),
    volumeCacheTtlSeconds: getConfigValue('cache.volumeCacheTtlSeconds'),
    feeStrategyTtlSeconds: getConfigValue('cache.feeStrategyTtlSeconds'),
  };
}

export function getAuthConfig() {
  return {
    maxLoginAttempts: getConfigValue('auth.maxLoginAttempts'),
    webauthnChallengeTtlSeconds: getConfigValue('auth.webauthnChallengeTtlSeconds'),
    adminApiKey: getConfigValue('auth.adminApiKey'),
  };
}
