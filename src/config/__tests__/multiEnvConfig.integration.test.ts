/**
 * Integration tests for multi-environment credential loading and config isolation
 */

import {
  loadAllProviderCredentials,
  validateEnvironmentCredentials,
  getCredentialsSummary,
  EnvironmentType,
} from '../credentialLoader';
import { redact } from '../../utils/redact';

describe('Multi-Environment Configuration Integration Tests', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Clear all provider credentials
    const envVars = Object.keys(process.env);
    envVars.forEach(key => {
      if (key.includes('_API_KEY') || key.includes('_API_SECRET') || key.includes('_CALLBACK_SECRET') || key.includes('_BASE_URL')) {
        delete process.env[key];
      }
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('Development Environment Flow', () => {
    it('loads development config with mock credentials', () => {
      process.env.NODE_ENV = 'development';
      process.env.MTN_API_KEY = 'mock_mtn_key_dev';
      process.env.MTN_API_SECRET = 'mock_mtn_secret_dev';
      process.env.MTN_CALLBACK_SECRET = 'mock_mtn_callback_dev';
      process.env.MTN_BASE_URL = 'https://mtn-dev.example.com';

      const credentials = loadAllProviderCredentials('development');

      expect(credentials.environment).toBe('development');
      expect(credentials.mtn).toBeDefined();
      expect(credentials.mtn?.baseUrl).toBe('https://mtn-dev.example.com');

      // Verify credentials are not logged in plaintext
      const summary = getCredentialsSummary(credentials);
      const summaryJson = JSON.stringify(summary);
      expect(summaryJson).not.toContain('mock_mtn_key_dev');
      expect(summaryJson).not.toContain('mock_mtn_secret_dev');
    });

    it('allows partial provider setup in development', () => {
      process.env.NODE_ENV = 'development';
      process.env.MTN_API_KEY = 'mock_key';
      process.env.MTN_API_SECRET = 'mock_secret';
      process.env.MTN_CALLBACK_SECRET = 'mock_callback';
      process.env.MTN_BASE_URL = 'https://mtn.dev.com';
      // Airtel and Orange not configured

      const credentials = loadAllProviderCredentials('development');

      expect(credentials.mtn).toBeDefined();
      expect(credentials.airtel).toBeUndefined();
      expect(credentials.orange).toBeUndefined();
    });

    it('allows empty credentials in development', () => {
      process.env.NODE_ENV = 'development';

      const result = validateEnvironmentCredentials('development');

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('Staging Environment Flow', () => {
    it('requires all providers to be configured in staging', () => {
      process.env.NODE_ENV = 'staging';
      process.env.MTN_API_KEY = 'staging_mtn_key';
      process.env.MTN_API_SECRET = 'staging_mtn_secret';
      process.env.MTN_CALLBACK_SECRET = 'staging_mtn_callback';
      process.env.MTN_BASE_URL = 'https://mtn-staging.example.com';
      // Airtel not configured - should fail

      const result = validateEnvironmentCredentials('staging');

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('accepts mock credentials in staging', () => {
      process.env.NODE_ENV = 'staging';
      
      // Configure all providers with mock credentials
      ['mtn', 'airtel', 'orange'].forEach(provider => {
        const prefix = provider.toUpperCase();
        process.env[`${prefix}_API_KEY`] = `mock_${provider}_key`;
        process.env[`${prefix}_API_SECRET`] = `mock_${provider}_secret`;
        process.env[`${prefix}_CALLBACK_SECRET`] = `mock_${provider}_callback`;
        process.env[`${prefix}_BASE_URL`] = `https://${provider}-staging.com`;
      });

      const result = validateEnvironmentCredentials('staging');

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts real credentials in staging', () => {
      process.env.NODE_ENV = 'staging';
      
      // Configure with real-looking credentials
      process.env.MTN_API_KEY = 'real_staging_mtn_key_abc123';
      process.env.MTN_API_SECRET = 'real_staging_mtn_secret_def456';
      process.env.MTN_CALLBACK_SECRET = 'real_staging_mtn_callback_ghi789';
      process.env.MTN_BASE_URL = 'https://mtn-staging-api.example.com';
      
      process.env.AIRTEL_API_KEY = 'real_staging_airtel_key_xyz789';
      process.env.AIRTEL_API_SECRET = 'real_staging_airtel_secret_abc123';
      process.env.AIRTEL_CALLBACK_SECRET = 'real_staging_airtel_callback_def456';
      process.env.AIRTEL_BASE_URL = 'https://airtel-staging-api.example.com';
      
      process.env.ORANGE_API_KEY = 'real_staging_orange_key_ghi789';
      process.env.ORANGE_API_SECRET = 'real_staging_orange_secret_xyz789';
      process.env.ORANGE_CALLBACK_SECRET = 'real_staging_orange_callback_abc123';
      process.env.ORANGE_BASE_URL = 'https://orange-staging-api.example.com';

      const result = validateEnvironmentCredentials('staging');

      expect(result.valid).toBe(true);
    });
  });

  describe('Production Environment Flow', () => {
    it('rejects missing credentials in production', () => {
      process.env.NODE_ENV = 'production';

      const result = validateEnvironmentCredentials('production');

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('rejects mock credentials in production', () => {
      process.env.NODE_ENV = 'production';
      
      ['mtn', 'airtel', 'orange'].forEach(provider => {
        const prefix = provider.toUpperCase();
        process.env[`${prefix}_API_KEY`] = `mock_${provider}_key`;
        process.env[`${prefix}_API_SECRET`] = `mock_${provider}_secret`;
        process.env[`${prefix}_CALLBACK_SECRET`] = `mock_${provider}_callback`;
        process.env[`${prefix}_BASE_URL`] = `https://${provider}-prod.com`;
      });

      const result = validateEnvironmentCredentials('production');

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Mock credentials'))).toBe(true);
    });

    it('accepts real credentials in production', () => {
      process.env.NODE_ENV = 'production';
      
      ['mtn', 'airtel', 'orange'].forEach(provider => {
        const prefix = provider.toUpperCase();
        process.env[`${prefix}_API_KEY`] = `prod_${provider}_sk_live_real_key_${Math.random().toString(36)}`;
        process.env[`${prefix}_API_SECRET`] = `prod_${provider}_secret_real_${Math.random().toString(36)}`;
        process.env[`${prefix}_CALLBACK_SECRET`] = `prod_${provider}_callback_${Math.random().toString(36)}`;
        process.env[`${prefix}_BASE_URL`] = `https://${provider}-api.prod.example.com`;
      });

      const result = validateEnvironmentCredentials('production');

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('ensures production credentials never appear in logs', () => {
      process.env.NODE_ENV = 'production';
      
      const prodKey = `prod_mtn_sk_live_${Math.random().toString(36).substring(7)}`;
      const prodSecret = `prod_mtn_secret_${Math.random().toString(36).substring(7)}`;
      
      process.env.MTN_API_KEY = prodKey;
      process.env.MTN_API_SECRET = prodSecret;
      process.env.MTN_CALLBACK_SECRET = 'prod_mtn_callback_secret';
      process.env.MTN_BASE_URL = 'https://mtn-api.prod.com';
      
      ['airtel', 'orange'].forEach(provider => {
        const prefix = provider.toUpperCase();
        process.env[`${prefix}_API_KEY`] = `prod_${provider}_key_${Math.random().toString(36)}`;
        process.env[`${prefix}_API_SECRET`] = `prod_${provider}_secret_${Math.random().toString(36)}`;
        process.env[`${prefix}_CALLBACK_SECRET`] = `prod_${provider}_callback_${Math.random().toString(36)}`;
        process.env[`${prefix}_BASE_URL`] = `https://${provider}-api.prod.com`;
      });

      const credentials = loadAllProviderCredentials('production');
      
      // Simulate logging the credentials object
      const loggedObject = {
        status: 'initialized',
        credentials: credentials,
        timestamp: new Date().toISOString(),
      };

      const redacted = redact(loggedObject);
      const logOutput = JSON.stringify(redacted);

      // Verify production secrets are never exposed
      expect(logOutput).not.toContain(prodKey);
      expect(logOutput).not.toContain(prodSecret);

      // The entire credentials object should be redacted for safety
      expect(logOutput).toContain('"credentials":"[REDACTED]"');
    });
  });

  describe('Cross-Environment Credential Isolation', () => {
    it('prevents staging credentials leaking to production logs', () => {
      // Simulate development with staging credentials mistakenly loaded
      const stagingCredentials = {
        environment: 'staging' as EnvironmentType,
        loadedAt: new Date(),
        mtn: {
          apiKey: 'staging_secret_key_12345',
          apiSecret: 'staging_secret_secret_67890',
          callbackSecret: 'staging_callback_secret',
          baseUrl: 'https://staging-api.mtn.com',
        },
      };

      // When logging this
      const logEntry = {
        event: 'config_loaded',
        credentials: stagingCredentials,
        environment: 'production', // Wrong environment
      };

      const redacted = redact(logEntry);
      const logOutput = JSON.stringify(redacted);

      // Even if logged in production, credentials should be redacted
      expect(logOutput).not.toContain('staging_secret_key_12345');
      expect(logOutput).not.toContain('staging_secret_secret_67890');
      expect(logOutput).not.toContain('staging_callback_secret');
    });

    it('validates environment matches credential requirements', () => {
      // Setup production credentials
      process.env.NODE_ENV = 'production';
      process.env.MTN_API_KEY = 'real_prod_key';
      process.env.MTN_API_SECRET = 'real_prod_secret';
      process.env.MTN_CALLBACK_SECRET = 'real_prod_callback';
      process.env.MTN_BASE_URL = 'https://mtn-prod.com';
      process.env.AIRTEL_API_KEY = 'real_prod_key';
      process.env.AIRTEL_API_SECRET = 'real_prod_secret';
      process.env.AIRTEL_CALLBACK_SECRET = 'real_prod_callback';
      process.env.AIRTEL_BASE_URL = 'https://airtel-prod.com';
      process.env.ORANGE_API_KEY = 'real_prod_key';
      process.env.ORANGE_API_SECRET = 'real_prod_secret';
      process.env.ORANGE_CALLBACK_SECRET = 'real_prod_callback';
      process.env.ORANGE_BASE_URL = 'https://orange-prod.com';

      // Try to load as development (should work - development is lenient)
      const devCreds = loadAllProviderCredentials('development');
      expect(devCreds.mtn).toBeDefined();

      // Validate production requirements
      const prodValidation = validateEnvironmentCredentials('production');
      expect(prodValidation.valid).toBe(true);
    });
  });

  describe('Credential Summary for Safe Logging', () => {
    it('provides safe credential summary without exposing secrets', () => {
      process.env.NODE_ENV = 'production';
      
      const secretKey = `prod_key_${Math.random().toString(36).substring(7)}`;
      const secretSecret = `prod_secret_${Math.random().toString(36).substring(7)}`;
      const secretCallback = `prod_callback_${Math.random().toString(36).substring(7)}`;
      
      process.env.MTN_API_KEY = secretKey;
      process.env.MTN_API_SECRET = secretSecret;
      process.env.MTN_CALLBACK_SECRET = secretCallback;
      process.env.MTN_BASE_URL = 'https://mtn-api.prod.com';
      
      ['airtel', 'orange'].forEach(provider => {
        const prefix = provider.toUpperCase();
        process.env[`${prefix}_API_KEY`] = `prod_${provider}_key`;
        process.env[`${prefix}_API_SECRET`] = `prod_${provider}_secret`;
        process.env[`${prefix}_CALLBACK_SECRET`] = `prod_${provider}_callback`;
        process.env[`${prefix}_BASE_URL`] = `https://${provider}-api.prod.com`;
      });

      const credentials = loadAllProviderCredentials('production');
      const summary = getCredentialsSummary(credentials);
      const summaryJson = JSON.stringify(summary);

      // Secrets should not appear
      expect(summaryJson).not.toContain(secretKey);
      expect(summaryJson).not.toContain(secretSecret);
      expect(summaryJson).not.toContain(secretCallback);

      // But useful info should appear
      expect(summaryJson).toContain('production');
      expect(summaryJson).toContain('https://mtn-api.prod.com');
      expect(summaryJson).toContain('mtn');
      expect(summaryJson).toContain('loaded');
    });
  });

  describe('Configuration Loading Order', () => {
    it('validates environment-specific configuration sequentially', () => {
      process.env.NODE_ENV = 'staging';

      const validationSteps = [];

      // Step 1: Check development (should pass - development is lenient)
      const devValidation = validateEnvironmentCredentials('development');
      validationSteps.push(devValidation.valid);
      expect(devValidation.valid).toBe(true);

      // Step 2: Check staging (should fail - no credentials)
      const stagingValidation = validateEnvironmentCredentials('staging');
      validationSteps.push(stagingValidation.valid);
      expect(stagingValidation.valid).toBe(false);

      // Step 3: Check production (should fail - no credentials)
      const prodValidation = validateEnvironmentCredentials('production');
      validationSteps.push(prodValidation.valid);
      expect(prodValidation.valid).toBe(false);

      expect(validationSteps).toEqual([true, false, false]);
    });
  });
});
