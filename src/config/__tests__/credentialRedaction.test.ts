/**
 * Tests for provider credentials redaction in logs
 */

import { redact, REDACTED, isSensitiveKey } from '../../utils/redact';

describe('Credential Redaction: Provider Secrets', () => {
  describe('isSensitiveKey for provider credentials', () => {
    it('identifies provider API keys as sensitive', () => {
      expect(isSensitiveKey('MTN_API_KEY')).toBe(true);
      expect(isSensitiveKey('AIRTEL_API_KEY')).toBe(true);
      expect(isSensitiveKey('ORANGE_API_KEY')).toBe(true);
      expect(isSensitiveKey('mtn_api_key')).toBe(true);
      expect(isSensitiveKey('apiKey')).toBe(true);
    });

    it('identifies provider API secrets as sensitive', () => {
      expect(isSensitiveKey('MTN_API_SECRET')).toBe(true);
      expect(isSensitiveKey('AIRTEL_API_SECRET')).toBe(true);
      expect(isSensitiveKey('ORANGE_API_SECRET')).toBe(true);
      expect(isSensitiveKey('apiSecret')).toBe(true);
      expect(isSensitiveKey('api_secret')).toBe(true);
      expect(isSensitiveKey('api-secret')).toBe(true);
    });

    it('identifies callback secrets as sensitive', () => {
      expect(isSensitiveKey('callbackSecret')).toBe(true);
      expect(isSensitiveKey('CALLBACK_SECRET')).toBe(true);
      expect(isSensitiveKey('callback-secret')).toBe(true);
      expect(isSensitiveKey('callback_secret')).toBe(true);
      expect(isSensitiveKey('MTN_CALLBACK_SECRET')).toBe(true);
    });

    it('allows non-sensitive fields', () => {
      expect(isSensitiveKey('baseUrl')).toBe(false);
      expect(isSensitiveKey('environment')).toBe(false);
      expect(isSensitiveKey('provider')).toBe(false);
      expect(isSensitiveKey('loadedAt')).toBe(false);
    });
  });

  describe('Redacting provider credential objects', () => {
    it('redacts ProviderCredentials objects completely', () => {
      const credentials = {
        apiKey: 'sk_live_mtn_secret_key_12345',
        apiSecret: 'sk_secret_mtn_api_secret_67890',
        callbackSecret: 'webhook_callback_secret_abcdef',
        baseUrl: 'https://api.mtn.com',
      };

      const redacted = redact(credentials);

      expect(redacted).toEqual({
        apiKey: REDACTED,
        apiSecret: REDACTED,
        callbackSecret: REDACTED,
        baseUrl: 'https://api.mtn.com', // baseUrl is safe
      });
    });

    it('redacts nested provider configuration', () => {
      const config = {
        environment: 'production',
        providers: {
          mtn: {
            apiKey: 'secret_mtn_key',
            apiSecret: 'secret_mtn_secret',
            callbackSecret: 'secret_callback',
            baseUrl: 'https://mtn.com',
          },
          airtel: {
            apiKey: 'secret_airtel_key',
            apiSecret: 'secret_airtel_secret',
            callbackSecret: 'secret_airtel_callback',
            baseUrl: 'https://airtel.com',
          },
        },
      };

      const redacted = redact(config);

      expect(redacted).toEqual({
        environment: 'production',
        providers: {
          mtn: {
            apiKey: REDACTED,
            apiSecret: REDACTED,
            callbackSecret: REDACTED,
            baseUrl: 'https://mtn.com',
          },
          airtel: {
            apiKey: REDACTED,
            apiSecret: REDACTED,
            callbackSecret: REDACTED,
            baseUrl: 'https://airtel.com',
          },
        },
      });
    });

    it('redacts credentials in arrays', () => {
      const credentials = [
        {
          provider: 'mtn',
          apiKey: 'secret_key_1',
          apiSecret: 'secret_secret_1',
          baseUrl: 'https://mtn.com',
        },
        {
          provider: 'airtel',
          apiKey: 'secret_key_2',
          apiSecret: 'secret_secret_2',
          baseUrl: 'https://airtel.com',
        },
      ];

      const redacted = redact(credentials);

      expect(redacted).toEqual([
        {
          provider: 'mtn',
          apiKey: REDACTED,
          apiSecret: REDACTED,
          baseUrl: 'https://mtn.com',
        },
        {
          provider: 'airtel',
          apiKey: REDACTED,
          apiSecret: REDACTED,
          baseUrl: 'https://airtel.com',
        },
      ]);
    });

    it('handles stringified JSON with credentials', () => {
      const jsonString = JSON.stringify({
        apiKey: 'secret_key',
        apiSecret: 'secret_secret',
        baseUrl: 'https://api.com',
      });

      const redacted = redact(jsonString);
      const redactedStr = redacted as string;

      // Parse the redacted JSON to verify it's properly redacted
      const parsed = JSON.parse(redactedStr);
      expect(parsed.apiKey).toBe(REDACTED);
      expect(parsed.apiSecret).toBe(REDACTED);
      expect(parsed.baseUrl).toBe('https://api.com');
    });
  });

  describe('Redacting provider configuration in error handling', () => {
    it('redacts error objects with credential properties', () => {
      const error = {
        name: 'AuthenticationError',
        message: 'Failed to authenticate',
        apiKey: 'secret_key',
        apiSecret: 'secret_secret',
        statusCode: 401,
      };

      const redacted = redact(error);

      expect(redacted).toEqual({
        name: 'AuthenticationError',
        message: 'Failed to authenticate',
        apiKey: REDACTED,
        apiSecret: REDACTED,
        statusCode: 401,
      });
    });
  });

  describe('Redacting provider credentials in request/response logs', () => {
    it('redacts credentials from request objects', () => {
      const request = {
        method: 'POST',
        url: 'https://api.mtn.com/authenticate',
        headers: {
          'X-Api-Key': 'secret_api_key',
          'Content-Type': 'application/json',
        },
        body: {
          apiSecret: 'secret_api_secret',
          callbackSecret: 'secret_callback',
          amount: 1000,
        },
      };

      const redacted = redact(request) as any;

      expect(redacted.headers['X-Api-Key']).toBe(REDACTED);
      expect(redacted.body.apiSecret).toBe(REDACTED);
      expect(redacted.body.callbackSecret).toBe(REDACTED);
      expect(redacted.body.amount).toBe(1000);
      expect(redacted.method).toBe('POST');
    });

    it('redacts credentials from response objects', () => {
      const response = {
        status: 200,
        statusText: 'OK',
        data: {
          apiKey: 'returned_api_key',
          sessionToken: 'session_token_secret',
          userId: 'user123',
          expiresIn: 3600,
        },
      };

      const redacted = redact(response) as any;

      expect(redacted.data.apiKey).toBe(REDACTED);
      expect(redacted.data.sessionToken).toBe(REDACTED);
      expect(redacted.data.userId).toBe('user123');
      expect(redacted.status).toBe(200);
    });
  });

  describe('Redacting provider credentials in exception handling', () => {
    it('redacts credentials from axios-like error objects', () => {
      const axiosError = {
        message: 'Request failed',
        config: {
          url: 'https://api.airtel.com/send',
          method: 'POST',
          headers: {
            Authorization: 'Bearer secret_token',
            'X-Api-Key': 'secret_api_key',
          },
          data: JSON.stringify({
            apiSecret: 'secret_api_secret',
            amount: 5000,
          }),
        },
        response: {
          status: 401,
          data: {
            error: 'Unauthorized',
            apiKey: 'invalid_key',
          },
        },
      };

      const redacted = redact(axiosError) as any;

      expect(redacted.config.headers.Authorization).toBe(REDACTED);
      expect(redacted.config.headers['X-Api-Key']).toBe(REDACTED);
      expect(redacted.response.data.apiKey).toBe(REDACTED);

      // Parse the stringified data
      const parsedData = JSON.parse(redacted.config.data);
      expect(parsedData.apiSecret).toBe(REDACTED);
      expect(parsedData.amount).toBe(5000);
    });

    it('preserves structure while redacting sensitive fields', () => {
      const error = {
        type: 'ProviderAuthError',
        provider: 'mtn',
        apiKey: 'secret_mtn_key',
        apiSecret: 'secret_mtn_secret',
        attempt: 1,
        timestamp: '2024-01-01T00:00:00Z',
        retryable: true,
      };

      const redacted = redact(error) as any;

      // Verify all safe fields are preserved
      expect(redacted.type).toBe('ProviderAuthError');
      expect(redacted.provider).toBe('mtn');
      expect(redacted.attempt).toBe(1);
      expect(redacted.timestamp).toBe('2024-01-01T00:00:00Z');
      expect(redacted.retryable).toBe(true);

      // Verify sensitive fields are redacted
      expect(redacted.apiKey).toBe(REDACTED);
      expect(redacted.apiSecret).toBe(REDACTED);
    });
  });

  describe('Production log security', () => {
    it('ensures production logs never expose real credentials', () => {
      const productionLog = {
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        service: 'provider-service',
        message: 'Failed to initialize provider',
        provider: 'orange',
        credentials: {
          apiKey: 'prod_orange_sk_live_12345_secret',
          apiSecret: 'prod_orange_secret_67890_confidential',
          callbackSecret: 'prod_orange_callback_webhook_secret',
        },
        error: 'Invalid credentials',
      };

      const redacted = redact(productionLog);
      const redactedStr = JSON.stringify(redacted);

      // Verify no production secrets are in the output
      expect(redactedStr).not.toContain('prod_orange_sk_live');
      expect(redactedStr).not.toContain('prod_orange_secret');
      expect(redactedStr).not.toContain('prod_orange_callback_webhook');

      // Verify safe fields are preserved
      expect(redactedStr).toContain('"provider":"orange"');
      expect(redactedStr).toContain('"message":"Failed to initialize provider"');
      expect(redactedStr).toContain('"error":"Invalid credentials"');

      // Verify credentials are redacted
      expect(redactedStr).toContain(`"credentials":"${REDACTED}"`);
    });

    it('prevents credential leakage through nested structures', () => {
      const complexLog = {
        request: {
          provider: 'airtel',
          auth: {
            type: 'bearer',
            credentials: {
              apiKey: 'secret_key_12345',
              apiSecret: 'secret_secret_67890',
            },
          },
        },
        response: {
          sessionId: 'session_abc123',
          token: 'token_secret_def456',
        },
        config: {
          callbackSecret: 'webhook_secret_ghi789',
          baseUrl: 'https://api.airtel.com',
        },
      };

      const redacted = redact(complexLog) as any;
      const redactedStr = JSON.stringify(redacted);

      // Check that sensitive values are redacted
      expect(redactedStr).not.toContain('secret_key_12345');
      expect(redactedStr).not.toContain('secret_secret_67890');
      expect(redactedStr).not.toContain('token_secret_def456');
      expect(redactedStr).not.toContain('webhook_secret_ghi789');

      // Safe fields preserved
      expect(redacted.request.provider).toBe('airtel');
      expect(redacted.response.sessionId).toBe('session_abc123');
      expect(redacted.config.baseUrl).toBe('https://api.airtel.com');
    });
  });

  describe('Backward compatibility', () => {
    it('maintains redaction behavior for existing sensitive keys', () => {
      const data = {
        password: 'my_password',
        apiKey: 'my_api_key',
        token: 'my_token',
        secret: 'my_secret',
        authorization: 'Bearer token_value',
        callbackSecret: 'callback_value',
      };

      const redacted = redact(data);

      expect(redacted).toEqual({
        password: REDACTED,
        apiKey: REDACTED,
        token: REDACTED,
        secret: REDACTED,
        authorization: REDACTED,
        callbackSecret: REDACTED,
      });
    });
  });
});
