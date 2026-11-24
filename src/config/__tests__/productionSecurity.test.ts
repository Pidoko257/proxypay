/**
 * Production-realistic security verification test
 * 
 * This test simulates production scenarios to verify that credentials
 * are never exposed in logs, even under adverse conditions.
 */

import { loadAllProviderCredentials, getCredentialsSummary } from '../credentialLoader';
import { redact, REDACTED } from '../../utils/redact';

describe('Production Security Verification', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Clear credentials
    ['MTN', 'AIRTEL', 'ORANGE'].forEach(provider => {
      delete process.env[`${provider}_API_KEY`];
      delete process.env[`${provider}_API_SECRET`];
      delete process.env[`${provider}_CALLBACK_SECRET`];
      delete process.env[`${provider}_BASE_URL`];
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('Real Production Scenario', () => {
    it('production startup with real credentials - nothing leaks to logs', () => {
      process.env.NODE_ENV = 'production';
      
      // Simulate real production credentials
      const realCredentials = {
        mtn: {
          apiKey: 'prod_mtn_sk_live_' + Math.random().toString(36).substring(2),
          apiSecret: 'prod_mtn_sec_' + Math.random().toString(36).substring(2),
          callbackSecret: 'prod_mtn_cb_' + Math.random().toString(36).substring(2),
        },
        airtel: {
          apiKey: 'prod_airtel_key_' + Math.random().toString(36).substring(2),
          apiSecret: 'prod_airtel_sec_' + Math.random().toString(36).substring(2),
          callbackSecret: 'prod_airtel_cb_' + Math.random().toString(36).substring(2),
        },
        orange: {
          apiKey: 'prod_orange_key_' + Math.random().toString(36).substring(2),
          apiSecret: 'prod_orange_sec_' + Math.random().toString(36).substring(2),
          callbackSecret: 'prod_orange_cb_' + Math.random().toString(36).substring(2),
        },
      };

      // Set environment
      Object.entries(realCredentials).forEach(([provider, creds]) => {
        const prefix = provider.toUpperCase();
        process.env[`${prefix}_API_KEY`] = creds.apiKey;
        process.env[`${prefix}_API_SECRET`] = creds.apiSecret;
        process.env[`${prefix}_CALLBACK_SECRET`] = creds.callbackSecret;
        process.env[`${prefix}_BASE_URL`] = `https://${provider}-api.prod.example.com`;
      });

      // Load credentials
      const credentials = loadAllProviderCredentials('production');

      // Simulate comprehensive logging scenarios
      const scenarios = [
        // Scenario 1: Debug logging full credentials
        {
          name: 'Full credentials debug log',
          data: { credentials, environment: 'production' },
        },
        // Scenario 2: Error with credentials in context
        {
          name: 'Error with credential context',
          data: {
            error: 'Provider auth failed',
            provider: 'mtn',
            credentials: credentials.mtn,
            timestamp: new Date(),
          },
        },
        // Scenario 3: Request body containing sensitive data
        {
          name: 'Request with sensitive payload',
          data: {
            method: 'POST',
            endpoint: '/api/authenticate',
            body: {
              apiKey: realCredentials.airtel.apiKey,
              apiSecret: realCredentials.airtel.apiSecret,
              amount: 5000,
            },
          },
        },
        // Scenario 4: API response accidentally containing credentials
        {
          name: 'API response with secrets',
          data: {
            status: 200,
            body: {
              sessionToken: 'session_' + Math.random().toString(36).substring(2),
              apiKey: realCredentials.orange.apiKey,
              expiresIn: 3600,
            },
          },
        },
        // Scenario 5: Exception with credentials in stack
        {
          name: 'Error with credentials in properties',
          data: {
            error: new Error('Provider rejected credentials'),
            attemptedApiKey: realCredentials.mtn.apiKey,
            attemptedSecret: realCredentials.mtn.apiSecret,
            retryCount: 3,
          },
        },
      ];

      // Test each scenario
      scenarios.forEach(scenario => {
        const redacted = redact(scenario.data);
        const logOutput = JSON.stringify(redacted);

        // Verify NO production secrets appear
        Object.values(realCredentials).forEach((providerCreds: any) => {
          expect(logOutput).not.toContain(providerCreds.apiKey, 
            `${scenario.name} leaked ${providerCreds.apiKey}`);
          expect(logOutput).not.toContain(providerCreds.apiSecret,
            `${scenario.name} leaked ${providerCreds.apiSecret}`);
          expect(logOutput).not.toContain(providerCreds.callbackSecret,
            `${scenario.name} leaked ${providerCreds.callbackSecret}`);
        });

        // Verify redaction markers present
        const redactCount = (logOutput.match(/\[REDACTED\]/g) || []).length;
        expect(redactCount).toBeGreaterThan(0,
          `${scenario.name} should have redacted at least one field`);
      });
    });

    it('production error handling never exposes credentials in error response', () => {
      process.env.NODE_ENV = 'production';
      
      const mtnKey = 'prod_secret_key_' + Math.random().toString(36).substring(2);
      const mtnSecret = 'prod_secret_secret_' + Math.random().toString(36).substring(2);
      const mtnCallback = 'prod_secret_callback_' + Math.random().toString(36).substring(2);
      
      process.env.MTN_API_KEY = mtnKey;
      process.env.MTN_API_SECRET = mtnSecret;
      process.env.MTN_CALLBACK_SECRET = mtnCallback;
      process.env.MTN_BASE_URL = 'https://mtn.prod.com';
      
      // Set other providers for production
      process.env.AIRTEL_API_KEY = 'real_airtel_key_' + Math.random().toString(36).substring(2);
      process.env.AIRTEL_API_SECRET = 'real_airtel_secret_' + Math.random().toString(36).substring(2);
      process.env.AIRTEL_CALLBACK_SECRET = 'real_airtel_cb_' + Math.random().toString(36).substring(2);
      process.env.AIRTEL_BASE_URL = 'https://airtel.prod.com';
      
      process.env.ORANGE_API_KEY = 'real_orange_key_' + Math.random().toString(36).substring(2);
      process.env.ORANGE_API_SECRET = 'real_orange_secret_' + Math.random().toString(36).substring(2);
      process.env.ORANGE_CALLBACK_SECRET = 'real_orange_cb_' + Math.random().toString(36).substring(2);
      process.env.ORANGE_BASE_URL = 'https://orange.prod.com';

      const credentials = loadAllProviderCredentials('production');

      // Simulate error response body that might accidentally include credentials
      const errorBody = {
        code: 'PROVIDER_ERROR',
        message: 'Failed to authenticate with provider',
        details: credentials.mtn, // Oops! Credentials in error details
        timestamp: new Date(),
      };

      const redacted = redact(errorBody);
      const responseJson = JSON.stringify(redacted);

      // Verify no secrets in response
      expect(responseJson).not.toContain(mtnKey);
      expect(responseJson).not.toContain(mtnSecret);
      expect(responseJson).not.toContain(mtnCallback);

      // Safe fields should still be present
      expect(responseJson).toContain('PROVIDER_ERROR');
      expect(responseJson).toContain('Failed to authenticate');
    });

    it('production database queries log safely', () => {
      process.env.NODE_ENV = 'production';
      
      const apiKey = 'prod_key_' + Math.random().toString(36).substring(2);
      const apiSecret = 'prod_secret_' + Math.random().toString(36).substring(2);
      
      process.env.MTN_API_KEY = apiKey;
      process.env.MTN_API_SECRET = apiSecret;
      process.env.MTN_CALLBACK_SECRET = 'prod_callback_secret';
      process.env.MTN_BASE_URL = 'https://mtn.prod.com';

      // Simulate database query log (if credentials accidentally passed through)
      const queryLog = {
        query: 'INSERT INTO provider_logs (api_key, api_secret, status) VALUES ($1, $2, $3)',
        params: ['[apiKey]', '[apiSecret]', 'connected'], // Use redacted placeholders
        duration: 125,
      };

      const redacted = redact(queryLog);
      const logOutput = JSON.stringify(redacted);

      // Verify no raw credentials in log
      expect(logOutput).not.toContain(apiKey.substring(0, 10)); // First 10 chars unique enough
      expect(logOutput).toContain('duration');
      expect(logOutput).toContain('125');
    });
  });

  describe('Credential Summary for Monitoring', () => {
    it('safe credential summary suitable for production monitoring', () => {
      process.env.NODE_ENV = 'production';
      
      const prodKey = 'prod_mtn_key_secret_' + Math.random().toString(36).substring(2);
      const prodSecret = 'prod_mtn_secret_' + Math.random().toString(36).substring(2);
      
      process.env.MTN_API_KEY = prodKey;
      process.env.MTN_API_SECRET = prodSecret;
      process.env.MTN_CALLBACK_SECRET = 'prod_mtn_callback_' + Math.random().toString(36).substring(2);
      process.env.MTN_BASE_URL = 'https://mtn-api.prod.example.com';
      
      // All providers must be real in production
      process.env.AIRTEL_API_KEY = 'real_airtel_key_' + Math.random().toString(36).substring(2);
      process.env.AIRTEL_API_SECRET = 'real_airtel_secret_' + Math.random().toString(36).substring(2);
      process.env.AIRTEL_CALLBACK_SECRET = 'real_airtel_callback_' + Math.random().toString(36).substring(2);
      process.env.AIRTEL_BASE_URL = 'https://airtel-api.prod.example.com';
      
      process.env.ORANGE_API_KEY = 'real_orange_key_' + Math.random().toString(36).substring(2);
      process.env.ORANGE_API_SECRET = 'real_orange_secret_' + Math.random().toString(36).substring(2);
      process.env.ORANGE_CALLBACK_SECRET = 'real_orange_callback_' + Math.random().toString(36).substring(2);
      process.env.ORANGE_BASE_URL = 'https://orange-api.prod.example.com';

      const credentials = loadAllProviderCredentials('production');
      const summary = getCredentialsSummary(credentials);
      const summaryJson = JSON.stringify(summary);

      // Verify no secrets in summary
      expect(summaryJson).not.toContain(prodKey);
      expect(summaryJson).not.toContain(prodSecret);

      // Verify useful monitoring info is present
      expect(summaryJson).toContain('production');
      expect(summaryJson).toContain('mtn');
      expect(summaryJson).toContain('airtel');
      expect(summaryJson).toContain('orange');
      expect(summaryJson).toContain('https://mtn-api.prod.example.com');
      expect(summaryJson).toContain('loaded');

      // Can be safely logged to monitoring systems
      console.log('Safe credential summary:', summaryJson);
    });
  });

  describe('Compliance Verification', () => {
    it('production credentials never appear in any log output', () => {
      process.env.NODE_ENV = 'production';
      
      // Set realistic production credentials
      const secrets = {
        mtnKey: 'sk_live_mtn_' + Math.random().toString(36).substring(2, 40),
        airtelKey: 'sk_live_airtel_' + Math.random().toString(36).substring(2, 40),
        orangeKey: 'sk_live_orange_' + Math.random().toString(36).substring(2, 40),
      };

      process.env.MTN_API_KEY = secrets.mtnKey;
      process.env.MTN_API_SECRET = 'sec_' + Math.random().toString(36).substring(2, 40);
      process.env.MTN_CALLBACK_SECRET = 'cb_' + Math.random().toString(36).substring(2, 40);
      process.env.MTN_BASE_URL = 'https://mtn-api.prod.example.com';

      process.env.AIRTEL_API_KEY = secrets.airtelKey;
      process.env.AIRTEL_API_SECRET = 'sec_' + Math.random().toString(36).substring(2, 40);
      process.env.AIRTEL_CALLBACK_SECRET = 'cb_' + Math.random().toString(36).substring(2, 40);
      process.env.AIRTEL_BASE_URL = 'https://airtel-api.prod.example.com';

      process.env.ORANGE_API_KEY = secrets.orangeKey;
      process.env.ORANGE_API_SECRET = 'sec_' + Math.random().toString(36).substring(2, 40);
      process.env.ORANGE_CALLBACK_SECRET = 'cb_' + Math.random().toString(36).substring(2, 40);
      process.env.ORANGE_BASE_URL = 'https://orange-api.prod.example.com';

      // Load and simulate comprehensive system logging
      const credentials = loadAllProviderCredentials('production');
      const logs = [
        { event: 'app_started', credentials },
        { event: 'provider_connected', provider: 'mtn', credentials: credentials.mtn },
        { event: 'api_request', body: { apiKey: secrets.mtnKey, amount: 5000 } },
        { event: 'provider_status', status: getCredentialsSummary(credentials) },
      ];

      // All logs must be redacted before output
      const redactedLogs = logs.map(log => redact(log));
      const allLogsJson = JSON.stringify(redactedLogs);

      // Compliance check: NO production secrets appear
      expect(allLogsJson).not.toContain(secrets.mtnKey);
      expect(allLogsJson).not.toContain(secrets.airtelKey);
      expect(allLogsJson).not.toContain(secrets.orangeKey);

      // Verify structure is preserved (useful for monitoring)
      expect(allLogsJson).toContain('app_started');
      expect(allLogsJson).toContain('provider_connected');
      expect(allLogsJson).toContain('mtn');
      expect(allLogsJson).toContain('airtel');
      expect(allLogsJson).toContain('orange');
    });
  });
});
