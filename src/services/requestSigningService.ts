import crypto from "crypto";
import { queryRead, queryWrite } from "../config/database";
import { redis } from "../config/redis";
import logger from "../utils/logger";
import axios from "axios";

export type SignatureAlgorithm = "HMAC-SHA256" | "RSA-SHA256";

export interface SignedRequest {
  signature: string;
  timestamp: string;
  nonce: string;
  algorithm: string;
  keyVersion: number;
}

export interface SignatureVerificationResult {
  valid: boolean;
  error?: string;
  keyVersion?: number;
  timestamp?: string;
}

/**
 * Cryptographic Request Signing Service
 * Implements HMAC-SHA256 signing for all provider API calls
 */
export class RequestSigningService {
  private masterKey: string;

  constructor() {
    this.masterKey = process.env.MASTER_ENCRYPTION_KEY || "";
    if (!this.masterKey && process.env.NODE_ENV === "production") {
      throw new Error("MASTER_ENCRYPTION_KEY required in production");
    }
  }

  /**
   * Generate HMAC-SHA256 signature for request
   */
  async generateSignature(
    provider: string,
    method: string,
    path: string,
    body: string | object,
    timestamp?: string,
    nonce?: string,
  ): Promise<SignedRequest> {
    // Get active API key for provider
    const key = await this.getActiveKey(provider);
    if (!key) throw new Error(`No active key for provider: ${provider}`);

    // Generate timestamp and nonce
    const ts = timestamp || new Date().toISOString();
    const n = nonce || this.generateNonce();

    // Decrypt key material
    const decryptedKey = this.decryptKey(key.key_material);

    // Build signature string (canonical form)
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    const signatureString = this.buildSignatureString(method, path, bodyStr, ts, n);

    // Generate HMAC-SHA256
    const signature = crypto
      .createHmac("sha256", decryptedKey)
      .update(signatureString)
      .digest("hex");

    // Log for audit
    await this.logSignatureGeneration(provider, signature, key.version, ts, n);

    return {
      signature,
      timestamp: ts,
      nonce: n,
      algorithm: "HMAC-SHA256",
      keyVersion: key.version,
    };
  }

  /**
   * Verify signature on provider request
   */
  async verifySignature(
    provider: string,
    method: string,
    path: string,
    body: string | object,
    providedSignature: string,
    timestamp: string,
    nonce: string,
    keyVersion?: number,
  ): Promise<SignatureVerificationResult> {
    try {
      // Validate timestamp (prevent old requests)
      if (!this.isValidTimestamp(timestamp, 5 * 60 * 1000)) {
        // 5 minute window
        await this.logSignatureFailure(provider, "timestamp_invalid", nonce);
        return { valid: false, error: "Request timestamp too old" };
      }

      // Check for replay attack
      if (!(await this.checkNonce(nonce, provider))) {
        await this.logSignatureFailure(provider, "replay_attack", nonce);
        return { valid: false, error: "Nonce replay detected" };
      }

      // Get key (use specified version or active)
      let key = keyVersion ? await this.getKeyByVersion(provider, keyVersion) : await this.getActiveKey(provider);

      if (!key) {
        await this.logSignatureFailure(provider, "key_not_found", nonce);
        return { valid: false, error: "Key not found" };
      }

      // Decrypt key
      const decryptedKey = this.decryptKey(key.key_material);

      // Build signature string
      const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
      const signatureString = this.buildSignatureString(method, path, bodyStr, timestamp, nonce);

      // Generate expected signature
      const expectedSignature = crypto
        .createHmac("sha256", decryptedKey)
        .update(signatureString)
        .digest("hex");

      // Constant-time comparison
      const isValid = crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(providedSignature),
      );

      if (!isValid) {
        await this.logSignatureFailure(provider, "invalid_signature", nonce);
      }

      return {
        valid: isValid,
        keyVersion: key.version,
        timestamp,
      };
    } catch (error) {
      logger.error("Signature verification error:", error);
      await this.logSignatureFailure(provider, "verification_error", nonce);
      return { valid: false, error: "Verification failed" };
    }
  }

  /**
   * Sign HTTP request and add headers
   */
  async signHttpRequest(
    provider: string,
    method: string,
    path: string,
    data?: any,
  ): Promise<{ [key: string]: string }> {
    const signature = await this.generateSignature(provider, method, path, data || "");

    return {
      "X-Signature": signature.signature,
      "X-Signature-Timestamp": signature.timestamp,
      "X-Signature-Nonce": signature.nonce,
      "X-Signature-Algorithm": signature.algorithm,
      "X-Signature-Key-Version": signature.keyVersion.toString(),
    };
  }

  /**
   * Verify webhook signature from provider
   */
  async verifyWebhookSignature(
    provider: string,
    payload: string | object,
    providedSignature: string,
    timestamp: string,
    nonce: string,
  ): Promise<SignatureVerificationResult> {
    const result = await this.verifySignature(
      provider,
      "POST",
      "/webhook",
      payload,
      providedSignature,
      timestamp,
      nonce,
    );

    if (result.valid) {
      await this.logWebhookVerification(provider, providedSignature, true);
    } else {
      await this.logWebhookVerification(provider, providedSignature, false, result.error);
    }

    return result;
  }

  /**
   * Rotate API key for provider
   */
  async rotateKey(
    provider: string,
    newKeyMaterial: string,
    rotationReason: string,
    initiatedBy: string,
  ): Promise<string> {
    logger.info(`[Signing] Initiating key rotation for ${provider}`);

    // Create new key version
    const encryptedKey = this.encryptKey(newKeyMaterial);

    const result = await queryWrite(
      `INSERT INTO provider_api_keys (
        provider_name, key_type, key_material, algorithm, created_by, 
        version, activated_at
      ) SELECT $1, 'hmac_secret', $2, 'HMAC-SHA256', $3, 
        COALESCE(MAX(version), 0) + 1, CURRENT_TIMESTAMP
      FROM provider_api_keys WHERE provider_name = $1
      RETURNING id, version`,
      [provider, encryptedKey, initiatedBy],
    );

    const newKeyId = result.rows[0].id;
    const newVersion = result.rows[0].version;

    // Log rotation
    await queryWrite(
      `INSERT INTO key_rotation_history (provider_name, new_key_id, rotation_reason, initiated_by, status)
       VALUES ($1, $2, $3, $4, 'completed')`,
      [provider, newKeyId, rotationReason, initiatedBy],
    );

    // Invalidate cache
    await redis.del(`key:${provider}:active`);

    logger.info(`[Signing] Key rotated for ${provider} (version ${newVersion})`);

    return newKeyId;
  }

  /**
   * Get active key for provider
   */
  private async getActiveKey(provider: string): Promise<any> {
    const cacheKey = `key:${provider}:active`;

    // Check cache
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // Get from DB
    const result = await queryRead(
      `SELECT * FROM provider_api_keys 
       WHERE provider_name = $1 AND is_active = true
       ORDER BY version DESC LIMIT 1`,
      [provider],
    );

    if (result.rows.length === 0) {
      return null;
    }

    const key = result.rows[0];

    // Cache for 1 hour
    await redis.setex(cacheKey, 3600, JSON.stringify(key));

    return key;
  }

  /**
   * Get specific key version
   */
  private async getKeyByVersion(provider: string, version: number): Promise<any> {
    const result = await queryRead(
      `SELECT * FROM provider_api_keys 
       WHERE provider_name = $1 AND version = $2`,
      [provider, version],
    );

    return result.rows[0] || null;
  }

  /**
   * Build canonical signature string
   */
  private buildSignatureString(
    method: string,
    path: string,
    body: string,
    timestamp: string,
    nonce: string,
  ): string {
    // Canonical form: METHOD\nPATH\nBODY_HASH\nTIMESTAMP\nNONCE
    const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
    return `${method}\n${path}\n${bodyHash}\n${timestamp}\n${nonce}`;
  }

  /**
   * Encrypt key material
   */
  private encryptKey(keyMaterial: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      "aes-256-gcm",
      Buffer.from(this.masterKey, "hex"),
      iv,
    );

    let encrypted = cipher.update(keyMaterial, "utf8", "hex");
    encrypted += cipher.final("hex");

    const authTag = cipher.getAuthTag();
    return iv.toString("hex") + authTag.toString("hex") + encrypted;
  }

  /**
   * Decrypt key material
   */
  private decryptKey(encryptedKey: string): string {
    const iv = Buffer.from(encryptedKey.slice(0, 32), "hex");
    const authTag = Buffer.from(encryptedKey.slice(32, 64), "hex");
    const encrypted = encryptedKey.slice(64);

    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      Buffer.from(this.masterKey, "hex"),
      iv,
    );

    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  }

  /**
   * Generate cryptographically secure nonce
   */
  private generateNonce(): string {
    return crypto.randomBytes(16).toString("hex");
  }

  /**
   * Validate request timestamp
   */
  private isValidTimestamp(timestamp: string, maxAgeMs: number): boolean {
    try {
      const requestTime = new Date(timestamp).getTime();
      const now = Date.now();
      const diff = now - requestTime;

      return diff >= 0 && diff <= maxAgeMs;
    } catch {
      return false;
    }
  }

  /**
   * Check nonce for replay attacks
   */
  private async checkNonce(nonce: string, provider: string): Promise<boolean> {
    const key = `nonce:${provider}:${nonce}`;

    const exists = await redis.exists(key);
    if (exists) {
      return false; // Replay detected
    }

    // Mark nonce as used (TTL: 5 minutes)
    await redis.setex(key, 300, "1");

    return true;
  }

  /**
   * Log signature generation for audit
   */
  private async logSignatureGeneration(
    provider: string,
    signature: string,
    keyVersion: number,
    timestamp: string,
    nonce: string,
  ): Promise<void> {
    try {
      await queryWrite(
        `INSERT INTO signature_audit_logs (
          provider_name, signature_algorithm, api_key_version, signature_provided,
          signature_valid, request_timestamp, nonce
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [provider, "HMAC-SHA256", keyVersion, signature, true, timestamp, nonce],
      );
    } catch (error) {
      logger.error("Failed to log signature:", error);
    }
  }

  /**
   * Log signature failure
   */
  private async logSignatureFailure(
    provider: string,
    reason: string,
    nonce: string,
  ): Promise<void> {
    try {
      await queryWrite(
        `INSERT INTO signature_failures (provider_name, failure_reason, nonce, severity)
         VALUES ($1, $2, $3, $4)`,
        [provider, reason, nonce, this.calculateSeverity(reason)],
      );
    } catch (error) {
      logger.error("Failed to log signature failure:", error);
    }
  }

  /**
   * Log webhook signature verification
   */
  private async logWebhookVerification(
    provider: string,
    signature: string,
    valid: boolean,
    error?: string,
  ): Promise<void> {
    try {
      await queryWrite(
        `INSERT INTO webhook_signatures (provider_name, signature_provided, signature_algorithm, signature_valid)
         VALUES ($1, $2, $3, $4)`,
        [provider, signature, "HMAC-SHA256", valid],
      );
    } catch (error) {
      logger.error("Failed to log webhook verification:", error);
    }
  }

  /**
   * Calculate severity level for failure
   */
  private calculateSeverity(reason: string): string {
    const criticalReasons = ["replay_attack", "invalid_signature", "key_not_found"];
    return criticalReasons.includes(reason) ? "critical" : "high";
  }
}

export const requestSigningService = new RequestSigningService();
