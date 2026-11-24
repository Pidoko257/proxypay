/**
 * Tests for environment-specific credential loading and isolation
 */

import {
  loadProviderCredentials,
  loadAllProviderCredentials,
  validateEnvironmentCredentials,
  isMockCredential,
  isValidCredential,
  getCredentialsSummary,
  EnvironmentType,
  ENVIRONMENT_REQUIREMENTS,
} from '../credentialLoader';

describe('Credential Loader: Environment-Specific Isolation', () => {
  // Store original env vars
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment variables before each test
    process.env = { ...originalEnv };
    // Clear provider credentials
    delete process.env.MTN_API_KEY;
    delete process.env.MTN_API_SECRET;
    delete process.env.MTN_CALLBACK_SECRET;
    delete process.env.MTN_BASE_URL;
    delete process.env.AIRTEL_API_KEY;
    delete process.env.AIRTEL_API_SECRET;
    delete process.env.AIRTEL_CALLBACK_SECRET;
    delete process.env.AIRTEL_BASE_URL;
    delete process.env.ORANGE_API_KEY;
    delete process.env.ORANGE_API_SECRET;
    delete process.env.ORANGE_CALLBACK_SECRET;
    delete process.env.ORANGE_BASE_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('isMockCredential', () => {
    it('detects mock prefixes', () => {
      expect(isMockCredential('mock_key_12345')).toBe(true);
      expect(isMockCredential('test_secret_67890')).toBe(true);
      expect(isMockCredential('MOCK-KEY')).toBe(true);
      expect(isMockCredential('TEST-SECRET')).toBe(true);
      expect(isMockCredential('dummy_password')).toBe(true);
    });

    it('detects repeating character patterns', () => {
      expect(isMockCredential('xxxxxxxxxx')).toBe(true); // exactly 10 x's
      expect(isMockCredential('yyyyyyyyyyyy')).toBe(true); // 12 y's
      expect(isMockCredential('zzzzzzzzzzzzzz')).toBe(true); // 14 z's
    });

    it('detects repeating group patterns', () => {
      expect(isMockCredential('aaa_test')).toBe(true);
      expect(isMockCredential('bbb-secret')).toBe(true);
      expect(isMockCredential('ccc_key')).toBe(true);
    });

    it('rejects real-looking credentials', () => {
      expect(isMockCredential('sk_live_42a9d8f4b')).toBe(false);
      expect(isMockCredential('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).toBe(false);
      expect(isMockCredential('a1b2c3d4e5f6g7h8i9j0')).toBe(false);
    });
  });

  describe('isValidCredential', () => {
    it('accepts non-empty strings', () => {
      expect(isValidCredential('real_secret')).toBe(true);
      expect(isValidCredential('mock_key')).toBe(true);
    });

    it('rejects undefined', () => {
      expect(isValidCredential(undefined)).toBe(false);
    });

    it('rejects empty strings', () => {
      expect(isValidCredential('')).toBe(false);
      expect(isValidCredential('   ')).toBe(false);
    });
  });

  describe('Production Environment Isolation', () => {
    it('requires all credentials in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.MTN_API_KEY = 'real_key';
      process.env.MTN_API_SECRET = 'real_secret';
      process.env.MTN_CALLBACK_SECRET = 'real_callback';
      process.env.MTN_BASE_URL = 'https://api.mtn.com';

      const creds = loadProviderCredentials('mtn', 'production');
      expect(creds).toBeDefined();
      expect(creds?.apiKey).toBe('real_key');
    });

    it('rejects mock credentials in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.MTN_API_KEY = 'mock_key_12345';
      process.env.MTN_API_SECRET = 'mock_secret_67890';
      process.env.MTN_CALLBACK_SECRET = 'mock_callback';
      process.env.MTN_BASE_URL = 'https://api.mtn.com';

      expect(() => loadProviderCredentials('mtn', 'production')).toThrow(
        /Mock credentials.*not allowed.*production/
      );
    });

    it('throws when credentials missing in production', () => {
      process.env.NODE_ENV = 'production';

      expect(() => loadProviderCredentials('mtn', 'production')).toThrow(
        /credentials are required/
      );
    });

    it('throws when credentials incomplete in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.MTN_API_KEY = 'real_key';
      process.env.MTN_API_SECRET = 'real_secret';
      // Missing callback secret and base URL

      expect(() => loadProviderCredentials('mtn', 'production')).toThrow(
        /Incomplete.*credentials/
      );
    });

    it('ensures production credentials are never logged', () => {
      process.env.NODE_ENV = 'production';
      process.env.AIRTEL_API_KEY = 'prod_airtel_key_secret_123';
      process.env.AIRTEL_API_SECRET = 'prod_airtel_secret_456';
      process.env.AIRTEL_CALLBACK_SECRET = 'prod_airtel_callback_789';
      process.env.AIRTEL_BASE_URL = 'https://api.airtel.prod.com';

      const creds = loadProviderCredentials('airtel', 'production');
      const summary = getCredentialsSummary({
        airtel: creds!,
        environment: 'production',
        loadedAt: new Date(),
      });

      // Summary should not contain the secret values
      const summaryStr = JSON.stringify(summary);
      expect(summaryStr).not.toContain('prod_airtel_key_secret_123');
      expect(summaryStr).not.toContain('prod_airtel_secret_456');
      expect(summaryStr).not.toContain('prod_airtel_callback_789');
      expect(summaryStr).toContain('https://api.airtel.prod.com'); // baseUrl is safe to log
    });
  });

  describe('Staging Environment Isolation', () => {
    it('allows real credentials in staging', () => {
      process.env.NODE_ENV = 'staging';
      process.env.ORANGE_API_KEY = 'staging_orange_key';
      process.env.ORANGE_API_SECRET = 'staging_orange_secret';
      process.env.ORANGE_CALLBACK_SECRET = 'staging_orange_callback';
      process.env.ORANGE_BASE_URL = 'https://api.orange.staging.com';

      const creds = loadProviderCredentials('orange', 'staging');
      expect(creds).toBeDefined();
      expect(creds?.apiKey).toBe('staging_orange_key');
    });

    it('allows mock credentials in staging', () => {
      process.env.NODE_ENV = 'staging';
      process.env.ORANGE_API_KEY = 'mock_orange_key';
      process.env.ORANGE_API_SECRET = 'mock_orange_secret';
      process.env.ORANGE_CALLBACK_SECRET = 'mock_orange_callback';
      process.env.ORANGE_BASE_URL = 'https://api.orange.staging.com';

      const creds = loadProviderCredentials('orange', 'staging');
      expect(creds).toBeDefined();
      expect(creds?.apiKey).toBe('mock_orange_key');
    });

    it('rejects empty credentials in staging', () => {
      process.env.NODE_ENV = 'staging';

      expect(() => loadProviderCredentials('airtel', 'staging')).toThrow(
        /credentials are required/
      );
    });
  });

  describe('Development Environment Isolation', () => {
    it('allows real credentials in development', () => {
      process.env.NODE_ENV = 'development';
      process.env.MTN_API_KEY = 'dev_mtn_key';
      process.env.MTN_API_SECRET = 'dev_mtn_secret';
      process.env.MTN_CALLBACK_SECRET = 'dev_mtn_callback';
      process.env.MTN_BASE_URL = 'https://api.mtn.dev.com';

      const creds = loadProviderCredentials('mtn', 'development');
      expect(creds).toBeDefined();
      expect(creds?.apiKey).toBe('dev_mtn_key');
    });

    it('allows mock credentials in development', () => {
      process.env.NODE_ENV = 'development';
      process.env.MTN_API_KEY = 'mock_mtn_key';
      process.env.MTN_API_SECRET = 'mock_mtn_secret';
      process.env.MTN_CALLBACK_SECRET = 'mock_mtn_callback';
      process.env.MTN_BASE_URL = 'https://api.mtn.dev.com';

      const creds = loadProviderCredentials('mtn', 'development');
      expect(creds).toBeDefined();
    });

    it('allows empty credentials in development', () => {
      process.env.NODE_ENV = 'development';

      const creds = loadProviderCredentials('mtn', 'development');
      expect(creds).toBeNull();
    });
  });

  describe('loadAllProviderCredentials', () => {
    it('loads all available providers in development', () => {
      process.env.NODE_ENV = 'development';
      process.env.MTN_API_KEY = 'mock_mtn';
      process.env.MTN_API_SECRET = 'mock_mtn_secret';
      process.env.MTN_CALLBACK_SECRET = 'mock_mtn_callback';
      process.env.MTN_BASE_URL = 'https://mtn.com';
      process.env.AIRTEL_API_KEY = 'mock_airtel';
      process.env.AIRTEL_API_SECRET = 'mock_airtel_secret';
      process.env.AIRTEL_CALLBACK_SECRET = 'mock_airtel_callback';
      process.env.AIRTEL_BASE_URL = 'https://airtel.com';

      const loaded = loadAllProviderCredentials('development');
      expect(loaded.mtn).toBeDefined();
      expect(loaded.airtel).toBeDefined();
      expect(loaded.orange).toBeUndefined();
      expect(loaded.environment).toBe('development');
      expect(loaded.loadedAt).toBeInstanceOf(Date);
    });

    it('throws early if production credentials invalid', () => {
      process.env.NODE_ENV = 'production';
      process.env.MTN_API_KEY = 'mock_key'; // Invalid for production
      process.env.MTN_API_SECRET = 'mock_secret';
      process.env.MTN_CALLBACK_SECRET = 'mock_callback';
      process.env.MTN_BASE_URL = 'https://mtn.com';

      expect(() => loadAllProviderCredentials('production')).toThrow();
    });
  });

  describe('validateEnvironmentCredentials', () => {
    it('validates production requires credentials', () => {
      process.env.NODE_ENV = 'production';

      const result = validateEnvironmentCredentials('production');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatch(/required/);
    });

    it('validates development is lenient', () => {
      process.env.NODE_ENV = 'development';

      const result = validateEnvironmentCredentials('development');
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('validates staging requires credentials', () => {
      process.env.NODE_ENV = 'staging';

      const result = validateEnvironmentCredentials('staging');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('validates mixed environment states', () => {
      process.env.NODE_ENV = 'staging';
      process.env.MTN_API_KEY = 'mock_key';
      process.env.MTN_API_SECRET = 'mock_secret';
      process.env.MTN_CALLBACK_SECRET = 'mock_callback';
      process.env.MTN_BASE_URL = 'https://mtn.com';

      const result = validateEnvironmentCredentials('staging');
      // Should still fail for missing Airtel and Orange
      expect(result.valid).toBe(false);
    });
  });

  describe('getCredentialsSummary', () => {
    it('returns safe credential summary without exposing secrets', () => {
      process.env.NODE_ENV = 'production';
      process.env.AIRTEL_API_KEY = 'secret_airtel_key_12345';
      process.env.AIRTEL_API_SECRET = 'secret_airtel_secret_67890';
      process.env.AIRTEL_CALLBACK_SECRET = 'secret_callback';
      process.env.AIRTEL_BASE_URL = 'https://api.airtel.com';

      const creds = loadProviderCredentials('airtel', 'production');
      const summary = getCredentialsSummary({
        airtel: creds!,
        environment: 'production',
        loadedAt: new Date('2024-01-01T00:00:00Z'),
      });

      expect(summary.airtel).toBeDefined();
      expect((summary.airtel as any).loaded).toBe(true);
      expect((summary.airtel as any).baseUrl).toBe('https://api.airtel.com');
      expect((summary.airtel as any).apiKey).toBeUndefined();
      expect((summary.airtel as any).apiSecret).toBeUndefined();
      expect(JSON.stringify(summary)).not.toContain('secret_airtel_key');
      expect(JSON.stringify(summary)).not.toContain('secret_airtel_secret');
    });
  });

  describe('Provider-specific validation', () => {
    it('validates MTN credentials independently', () => {
      process.env.NODE_ENV = 'production';
      process.env.MTN_API_KEY = 'real_mtn_key';
      process.env.MTN_API_SECRET = 'real_mtn_secret';
      process.env.MTN_CALLBACK_SECRET = 'real_mtn_callback';
      process.env.MTN_BASE_URL = 'https://mtn.com';

      const mtn = loadProviderCredentials('mtn', 'production');
      expect(mtn?.apiKey).toBe('real_mtn_key');

      // Airtel is still missing and should throw
      expect(() => loadProviderCredentials('airtel', 'production')).toThrow();
    });

    it('validates Airtel credentials independently', () => {
      process.env.NODE_ENV = 'staging';
      process.env.AIRTEL_API_KEY = 'mock_airtel';
      process.env.AIRTEL_API_SECRET = 'mock_airtel_secret';
      process.env.AIRTEL_CALLBACK_SECRET = 'mock_airtel_callback';
      process.env.AIRTEL_BASE_URL = 'https://airtel.com';

      const airtel = loadProviderCredentials('airtel', 'staging');
      expect(airtel?.apiKey).toBe('mock_airtel');
    });

    it('validates Orange credentials independently', () => {
      process.env.NODE_ENV = 'development';
      process.env.ORANGE_API_KEY = 'dev_orange';
      process.env.ORANGE_API_SECRET = 'dev_orange_secret';
      process.env.ORANGE_CALLBACK_SECRET = 'dev_orange_callback';
      process.env.ORANGE_BASE_URL = 'https://orange.com';

      const orange = loadProviderCredentials('orange', 'development');
      expect(orange?.apiKey).toBe('dev_orange');
    });
  });
});
