# Cryptographic Request Signing Implementation

## Overview

ProxyPay implements industry-standard cryptographic request signing for all mobile money provider API calls. This prevents man-in-the-middle attacks, ensures request integrity, and provides comprehensive audit trails for compliance.

## Security Architecture

### Signing Algorithm: HMAC-SHA256

**Request Signing Flow:**
1. Build canonical request string: `METHOD\nPATH\nBODY_HASH\nTIMESTAMP\nNONCE`
2. Generate HMAC-SHA256 using provider's API key
3. Include signature in request headers
4. Add timestamp (5-minute window validation)
5. Include cryptographically random nonce (replay prevention)

**Example Request:**
```
POST /api/transactions HTTP/1.1
Host: provider.api.com
X-Signature: a1b2c3d4e5f6...
X-Signature-Timestamp: 2026-07-29T10:00:00Z
X-Signature-Nonce: 8f7e6d5c4b3a2a1b
X-Signature-Algorithm: HMAC-SHA256
X-Signature-Key-Version: 1

{
  "amount": 1000,
  "phoneNumber": "+237670000000",
  "provider": "MTN"
}
```

### API Key Management

**Storage:** AES-256-GCM Encryption
- Master encryption key in secrets manager (AWS Secrets Manager / HashiCorp Vault)
- Each key encrypted with unique IV (Initialization Vector)
- GCM authentication tag for tamper detection
- No plaintext keys on disk or in logs

**Key Structure:**
- Provider-specific keys (MTN, Airtel, Orange)
- Versioned for seamless rotation
- Active/inactive status tracking
- Expiration dates supported
- Full audit trail

**Access Control:**
- Keys only accessible via requestSigningService
- No manual access to decrypted material
- Redis caching with TTL (1 hour)
- Automatic cache invalidation on rotation

### Signature Verification

**Provider Request Verification:**
1. Extract signature, timestamp, nonce from request headers
2. Validate timestamp within 5-minute window
3. Check nonce against replay cache (Redis)
4. Fetch provider's active API key (with fallback to previous version during rotation)
5. Reconstruct canonical request string
6. Regenerate HMAC-SHA256 with decrypted key
7. Constant-time comparison (prevents timing attacks)
8. Log all attempts (valid and failed) for audit

**Webhook Callback Verification:**
1. Extract signature from X-Signature header
2. Extract timestamp from X-Signature-Timestamp
3. Extract nonce from X-Signature-Nonce
4. Perform same verification as requests (replay detection, timestamp validation)
5. Verify payload hash matches transmitted body
6. Log verification attempt with result

## Compliance

### PCI-DSS Compliance

**Requirement 3 (Protect Data):**
- ✅ Keys encrypted at rest (AES-256-GCM)
- ✅ Master key in HSM-compatible format
- ✅ No hardcoded keys anywhere
- ✅ Secure key lifecycle

**Requirement 8 (Identify & Authenticate):**
- ✅ Unique signatures per request
- ✅ Request integrity verification
- ✅ Non-repudiation via audit logs
- ✅ No key sharing across providers

**Requirement 10 (Log & Monitor):**
- ✅ Immutable audit logs (DELETE trigger prevention)
- ✅ All signature attempts logged
- ✅ Timestamp preservation
- ✅ Signature verification results tracked
- ✅ Key rotation audited
- ✅ Failed verification alerts

### OWASP Guidelines

**Cryptography Storage (CSM):**
- ✅ Strong algorithms (HMAC-SHA256)
- ✅ Proper key derivation (unique per provider)
- ✅ Sufficient key material (256-bit effective)
- ✅ Secure storage (AES-256-GCM)

**Cryptography Transmission (CTM):**
- ✅ HTTPS for all API calls (TLS 1.3)
- ✅ Signature validation on receipt
- ✅ Replay attack prevention (nonces)
- ✅ Timestamp validation (prevents old requests)

## Database Schema

### provider_api_keys
Secure storage for all provider API credentials
- Encrypted key material with AES-256-GCM
- Version tracking for seamless rotation
- Active/inactive status
- Key expiration support
- Rotation history

### signature_audit_logs (Immutable)
Every signed request logged for compliance
- Request identification and details
- Signature algorithm used
- Key version applied
- Signature validity (success/failure)
- Timestamp and nonce
- Cannot be deleted (DELETE trigger)

### webhook_signatures
Tracking for provider webhook callbacks
- Signature verification results
- Replay detection status
- Source IP tracking
- Transaction reference
- User agent logging

### key_rotation_history
Complete key rotation audit trail
- Old key → new key mapping
- Rotation reason
- Timeline tracking
- Completion status
- Initiated/completed by tracking

### signature_failures
Security monitoring for failed verifications
- Failure reason (invalid signature, replay, timestamp)
- Severity level (low/high/critical)
- Source IP for investigation
- Automatic alerting trigger

### nonce_cache
Fast lookup for replay prevention
- TTL-based expiration (5 minutes)
- Fast Redis-backed lookups
- Provider-specific namespacing

## Key Rotation

### Scheduled Rotation (Recommended: 90 days)
```
1. Generate new key
2. Create new version (v+1) in provider_api_keys
3. Mark old version as inactive after grace period
4. Log rotation event
5. Invalidate Redis cache
6. Provider notified of new key
```

### Emergency Rotation (Immediate)
```
1. Generate new key immediately
2. Activate new version
3. Revoke old version
4. Alert security team
5. Log incident
6. Notify provider
```

### Graceful Transition
- Old and new keys both accepted during rotation window
- Requests with either version verified successfully
- Nonces from both versions tracked
- Audit logs show version used
- No service disruption

## Timestamp Validation

**Window:** 5 minutes (configurable)

Prevents:
- Replay attacks (old timestamps rejected)
- Clock skew issues (5-minute tolerance)
- Delayed requests (network latency allowed)

```
// Valid if: current_time - request_time <= 5 minutes AND request_time <= current_time
```

## Nonce Management

**Generation:** Cryptographically secure (crypto.randomBytes(16))

**Replay Detection:**
1. Check if nonce exists in cache
2. If exists → reject (replay detected)
3. If not → add to cache with 5-minute TTL
4. Automatic cleanup via Redis expiration

**Redis Structure:**
```
nonce:provider:hash → "1" (TTL: 300s)
```

## Audit Logging

### What's Logged

**Signature Generation:**
- Provider name
- Request method/path
- Signature (truncated for display)
- Key version used
- Timestamp
- Nonce
- Success indicator

**Verification Attempts:**
- Provider name
- Signature validity result
- Failure reason (if failed)
- Key version
- Timestamp
- Source IP
- User agent

**Key Rotation:**
- Old key version
- New key version
- Rotation reason
- Initiated by
- Completion time
- Status

### Immutability

Audit logs cannot be deleted:
- PostgreSQL trigger prevents DELETE statements
- Raises exception on deletion attempt
- Legal hold compliance
- Tamper-evident design

## Security Best Practices

### For Providers

1. **Keep API Keys Secure**
   - Never share keys via email or chat
   - Rotate keys on schedule
   - Immediately notify on suspected compromise

2. **Signature Verification**
   - Always verify signatures on callbacks
   - Check timestamp (prevent replay)
   - Log all verification attempts

3. **Monitor for Failures**
   - Alert on repeated verification failures
   - Alert on unusual nonces
   - Track by source IP

### For ProxyPay Team

1. **Key Management**
   - Master encryption key in AWS Secrets Manager
   - Rotate master key quarterly
   - Access logs reviewed monthly

2. **Incident Response**
   - Suspected key compromise → immediate rotation
   - Failed signature threshold (10 in 5 min) → alert
   - Unusual patterns → investigation

3. **Testing**
   - Use security testing tools (signature generation/verification)
   - Test key rotation process quarterly
   - Verify replay detection works

## Monitoring & Alerting

### Metrics

- Signature verification success rate (target: >99%)
- Failed verification reasons (track by type)
- Key rotation completions
- Nonce collisions (replay attempts)
- API latency impact of signing (<50ms)

### Alerts

- Failed verification spike (>10 in 5 minutes)
- Replay attack detected
- Key rotation failures
- Master key access anomalies
- Audit log write failures

## Testing

### Security Testing Tools

**Generate Test Signature:**
```bash
curl -X POST http://localhost:3000/api/signing/test/generate \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "MTN",
    "method": "POST",
    "path": "/transactions",
    "body": {"amount": 1000}
  }'
```

**Verify Test Signature:**
```bash
curl -X POST http://localhost:3000/api/signing/test/verify \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "MTN",
    "signature": "abc123...",
    "timestamp": "2026-07-29T10:00:00Z",
    "nonce": "xyz789..."
  }'
```

### Test Scenarios

- ✅ Valid signature acceptance
- ✅ Invalid signature rejection
- ✅ Expired timestamp rejection
- ✅ Replay attack detection
- ✅ Key rotation verification
- ✅ Webhook callback verification

## Compliance Checklist

- [ ] Master encryption key in secrets manager
- [ ] All API keys encrypted (AES-256-GCM)
- [ ] HTTPS enabled for all API calls
- [ ] Signature audit logs immutable
- [ ] Key rotation schedule established
- [ ] Monitoring and alerting configured
- [ ] Security testing performed
- [ ] Incident response plan documented
- [ ] Staff training completed
- [ ] Quarterly compliance audit scheduled

## References

- OWASP Cryptography Cheat Sheet
- PCI-DSS v3.2.1 Requirements 3, 8, 10
- NIST SP 800-38D (GCM mode)
- RFC 7914 (Nonce generation)
