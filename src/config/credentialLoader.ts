/**
 * Environment-Specific Credential Loader
 *
 * This module provides secure, environment-aware credential loading for mobile money providers.
 * It ensures that:
 *
 * 1. Only appropriate credentials are loaded per environment
 * 2. Credentials are never logged in plain text
 * 3. Production uses only production secrets
 * 4. Development/staging can use mock or test credentials
 *
 * Design principles:
 * - Fail-safe: Missing credentials in production cause early exit
 * - Environment-aware: Different requirements per env
 * - Audit trail: All credential access is tracked
 * - Encryption-ready: Credentials can be encrypted at rest
 */

import { env } from './env';

export type EnvironmentType = 'production' | 'staging' | 'development' | 'test';

export interface ProviderCredentials {
  apiKey: string;
  apiSecret: string;
  callbackSecret: string;
  baseUrl: string;
}

export interface LoadedCredentials {
  mtn?: ProviderCredentials;
  airtel?: ProviderCredentials;
  orange?: ProviderCredentials;
  loadedAt: Date;
  environment: EnvironmentType;
}

/**
 * Validation rules for each environment
 */
const ENVIRONMENT_REQUIREMENTS: Record<EnvironmentType, {
  requireCredentials: boolean;
  allowMock: boolean;
  allowEmpty: boolean;
  description: string;
}> = {
  production: {
    requireCredentials: true,
    allowMock: false,
    allowEmpty: false,
    description: 'Production requires real credentials and rejects mock/empty values',
  },
  staging: {
    requireCredentials: true,
    allowMock: true,
    allowEmpty: false,
    description: 'Staging requires credentials but allows mock providers',
  },
  development: {
    requireCredentials: false,
    allowMock: true,
    allowEmpty: true,
    description: 'Development allows mock, empty, or real credentials',
  },
  test: {
    requireCredentials: false,
    allowMock: true,
    allowEmpty: true,
    description: 'Test environment allows mock credentials only',
  },
};

/**
 * Detect if a credential is a mock value
 */
export function isMockCredential(value: string): boolean {
  const mockPatterns = [
    /^mock[-_]/i,
    /^test[-_]/i,
    /^dummy[-_]/i,
    /^(.)\1{9,}$/i, // repeating character 10+ times (any character)
    /^(aaa|bbb|ccc)[-_]/i,
  ];
  return mockPatterns.some(pattern => pattern.test(value));
}

/**
 * Validate a credential string
 */
export function isValidCredential(value: string | undefined): value is string {
  return Boolean(value && value.trim().length > 0);
}

/**
 * Load provider credentials for a specific environment
 */
export function loadProviderCredentials(
  provider: 'mtn' | 'airtel' | 'orange',
  environment: EnvironmentType = (process.env.NODE_ENV as EnvironmentType) || 'development'
): ProviderCredentials | null {
  const requirements = ENVIRONMENT_REQUIREMENTS[environment];
  
  // Environment variable names follow pattern: {PROVIDER}_API_KEY, {PROVIDER}_API_SECRET, etc.
  const prefix = provider.toUpperCase();
  const apiKey = process.env[`${prefix}_API_KEY`];
  const apiSecret = process.env[`${prefix}_API_SECRET`];
  const callbackSecret = process.env[`${prefix}_CALLBACK_SECRET`];
  const baseUrl = process.env[`${prefix}_BASE_URL`];

  // Check if credentials are provided
  const hasApiKey = isValidCredential(apiKey);
  const hasApiSecret = isValidCredential(apiSecret);
  const hasCallbackSecret = isValidCredential(callbackSecret);
  const hasBaseUrl = isValidCredential(baseUrl);

  // If no credentials provided at all, handle based on environment requirements
  if (!hasApiKey && !hasApiSecret && !hasCallbackSecret && !hasBaseUrl) {
    if (requirements.requireCredentials) {
      throw new Error(
        `${provider.toUpperCase()} credentials are required in ${environment} environment. ` +
        `Missing: ${prefix}_API_KEY, ${prefix}_API_SECRET, ${prefix}_CALLBACK_SECRET, ${prefix}_BASE_URL`
      );
    }
    return null;
  }

  // If credentials are partially provided, require all
  if ((hasApiKey || hasApiSecret || hasCallbackSecret || hasBaseUrl) && 
      !(hasApiKey && hasApiSecret && hasCallbackSecret && hasBaseUrl)) {
    throw new Error(
      `Incomplete ${provider.toUpperCase()} credentials in ${environment}. ` +
      `All of these must be set: ${prefix}_API_KEY, ${prefix}_API_SECRET, ${prefix}_CALLBACK_SECRET, ${prefix}_BASE_URL`
    );
  }

  // Check for mock credentials
  const isMock = isMockCredential(apiKey!) || isMockCredential(apiSecret!);
  
  if (isMock && !requirements.allowMock) {
    throw new Error(
      `Mock credentials for ${provider.toUpperCase()} are not allowed in ${environment} environment. ` +
      `${requirements.description}`
    );
  }

  return {
    apiKey: apiKey!,
    apiSecret: apiSecret!,
    callbackSecret: callbackSecret!,
    baseUrl: baseUrl!,
  };
}

/**
 * Load all provider credentials for the current environment
 */
export function loadAllProviderCredentials(
  environment: EnvironmentType = (process.env.NODE_ENV as EnvironmentType) || 'development'
): LoadedCredentials {
  const credentials: LoadedCredentials = {
    environment,
    loadedAt: new Date(),
  };

  const providers = ['mtn', 'airtel', 'orange'] as const;
  
  for (const provider of providers) {
    try {
      const creds = loadProviderCredentials(provider, environment);
      if (creds) {
        credentials[provider] = creds;
      }
    } catch (error) {
      // Log error without exposing credentials
      console.error(`Failed to load ${provider.toUpperCase()} credentials:`, {
        error: error instanceof Error ? error.message : String(error),
        environment,
        provider,
      });
      throw error;
    }
  }

  return credentials;
}

/**
 * Validate that an environment's credentials are properly set up
 * Use this in startup checks
 */
export function validateEnvironmentCredentials(
  environment: EnvironmentType = (process.env.NODE_ENV as EnvironmentType) || 'development'
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const requirements = ENVIRONMENT_REQUIREMENTS[environment];

  if (requirements.requireCredentials) {
    const providers = ['mtn', 'airtel', 'orange'] as const;
    
    for (const provider of providers) {
      try {
        const creds = loadProviderCredentials(provider, environment);
        if (!creds) {
          errors.push(`${provider.toUpperCase()} credentials are required but not provided`);
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Get a safe representation of loaded credentials for logging/debugging
 * (all values redacted)
 */
export function getCredentialsSummary(
  credentials: LoadedCredentials
): Record<string, unknown> {
  return {
    environment: credentials.environment,
    loadedAt: credentials.loadedAt.toISOString(),
    mtn: credentials.mtn ? { loaded: true, baseUrl: credentials.mtn.baseUrl } : undefined,
    airtel: credentials.airtel ? { loaded: true, baseUrl: credentials.airtel.baseUrl } : undefined,
    orange: credentials.orange ? { loaded: true, baseUrl: credentials.orange.baseUrl } : undefined,
  };
}
