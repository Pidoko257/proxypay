# Task #158 - End-to-End Encryption Implementation Guide

## File Structure

```
src/crypto/
├── encryption.ts         # AES-256-GCM (EXISTS - enhance)
├── keyManagement.ts      # Key derivation & storage (NEW)
├── auditLog.ts           # Decryption access audit (NEW)
└── __tests__/
    ├── encryption.test.ts
    ├── keyManagement.test.ts
    └── integration.test.ts

src/models/
└── encrypted.ts          # ORM field decorator (NEW)

migrations/
└── 010_encrypt_pii_data.sql  # Data migration (NEW)
```

## 1. Key Management (keyManagement.ts)

```typescript
import crypto from "crypto";
import { redisClient } from "../config/redis";
import { logger } from "../services/logger";

export interface KeyMetadata {
  keyId: string;
  algorithm: string;
  version: number;
  createdAt: Date;
  rotatedAt?: Date;
  status: "active" | "inactive" | "rotated";
}

export class KeyManagement {
  private static readonly KEY_PREFIX = "encryption:keys";
  private static readonly MASTER_KEY_ROTATION_DAYS = 90;

  /**
   * Generate a new master key
   * Used for key encryption key (KEK)
   */
  static generateMasterKey(): string {
    return crypto.randomBytes(32).toString("hex");
  }

  /**
   * Derive per-user encryption key from master key + user ID
   * Deterministic: same user always gets same key
   */
  static deriveUserKey(userId: string, masterKey: string): Buffer {
    const hkdf = crypto.createHmac("sha256", masterKey);
    hkdf.update(userId);
    hkdf.update("pii-encryption"); // Context
    return hkdf.digest();
  }

  /**
   * Derive field-specific key
   * Enables rotating keys per field if needed
   */
  static deriveFieldKey(
    userId: string,
    fieldName: string,
    masterKey: string,
  ): Buffer {
    const hkdf = crypto.createHmac("sha256", masterKey);
    hkdf.update(userId);
    hkdf.update(fieldName);
    hkdf.update("field-encryption");
    return hkdf.digest();
  }

  /**
   * Store key metadata in Redis
   * Tracks key rotation and status
   */
  static async storeKeyMetadata(metadata: KeyMetadata): Promise<void> {
    const key = `${this.KEY_PREFIX}:${metadata.keyId}`;
    await redisClient.hset(key, {
      keyId: metadata.keyId,
      algorithm: metadata.algorithm,
      version: String(metadata.version),
      createdAt: metadata.createdAt.toISOString(),
      rotatedAt: metadata.rotatedAt?.toISOString() || "",
      status: metadata.status,
    });

    // Set expiry (6 months for rotated keys)
    if (metadata.status === "rotated") {
      await redisClient.expire(key, 180 * 24 * 60 * 60);
    }
  }

  /**
   * Get key metadata
   */
  static async getKeyMetadata(keyId: string): Promise<KeyMetadata | null> {
    const key = `${this.KEY_PREFIX}:${keyId}`;
    const data = await redisClient.hgetall(key);

    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    return {
      keyId: data.keyId,
      algorithm: data.algorithm,
      version: parseInt(data.version || "1", 10),
      createdAt: new Date(data.createdAt),
      rotatedAt: data.rotatedAt ? new Date(data.rotatedAt) : undefined,
      status: (data.status as "active" | "inactive" | "rotated") || "active",
    };
  }

  /**
   * Check if key needs rotation
   */
  static async needsRotation(keyId: string): Promise<boolean> {
    const metadata = await this.getKeyMetadata(keyId);
    if (!metadata) return false;

    const age = Date.now() - metadata.createdAt.getTime();
    const maxAge = this.MASTER_KEY_ROTATION_DAYS * 24 * 60 * 60 * 1000;

    return age > maxAge;
  }

  /**
   * List all active keys
   */
  static async listActiveKeys(): Promise<KeyMetadata[]> {
    const keys = await redisClient.keys(`${this.KEY_PREFIX}:*`);
    const metadata: KeyMetadata[] = [];

    for (const key of keys) {
      const keyId = key.split(":").pop();
      if (!keyId) continue;

      const data = await this.getKeyMetadata(keyId);
      if (data && data.status === "active") {
        metadata.push(data);
      }
    }

    return metadata;
  }

  /**
   * Mark key as rotated
   */
  static async rotateKey(keyId: string): Promise<void> {
    const metadata = await this.getKeyMetadata(keyId);
    if (!metadata) return;

    metadata.status = "rotated";
    metadata.rotatedAt = new Date();
    await this.storeKeyMetadata(metadata);

    logger.info("Key rotated", { keyId });
  }
}
```

## 2. Enhanced Encryption (encryption.ts enhancement)

```typescript
import crypto from "crypto";
import { KeyManagement } from "./keyManagement";
import { logger } from "../services/logger";

export interface EncryptedData {
  version: number;
  keyId: string;
  algorithm: string;
  iv: string; // hex
  authTag: string; // hex
  ciphertext: string; // hex
}

export class PiiEncryption {
  private static readonly ALGORITHM = "aes-256-gcm";
  private static readonly IV_LENGTH = 12;
  private static readonly AUTH_TAG_LENGTH = 16;
  private static readonly CURRENT_VERSION = 1;

  /**
   * Encrypt PII field with per-user key
   */
  static encrypt(
    plaintext: string,
    userId: string,
    fieldName: string,
    masterKey: string,
  ): EncryptedData {
    try {
      // Derive field-specific key
      const key = KeyManagement.deriveFieldKey(userId, fieldName, masterKey);

      // Generate random IV
      const iv = crypto.randomBytes(this.IV_LENGTH);

      // Create cipher
      const cipher = crypto.createCipheriv(this.ALGORITHM, key, iv);

      // Encrypt
      let ciphertext = cipher.update(plaintext, "utf8", "hex");
      ciphertext += cipher.final("hex");

      // Get auth tag
      const authTag = cipher.getAuthTag();

      return {
        version: this.CURRENT_VERSION,
        keyId: `${userId}:${fieldName}`,
        algorithm: this.ALGORITHM,
        iv: iv.toString("hex"),
        authTag: authTag.toString("hex"),
        ciphertext,
      };
    } catch (error) {
      logger.error("Encryption failed", {
        userId,
        fieldName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Decrypt PII field with per-user key
   */
  static decrypt(
    encrypted: EncryptedData,
    userId: string,
    fieldName: string,
    masterKey: string,
  ): string {
    try {
      // Verify version
      if (encrypted.version !== this.CURRENT_VERSION) {
        throw new Error(`Unsupported encryption version: ${encrypted.version}`);
      }

      // Derive field-specific key
      const key = KeyManagement.deriveFieldKey(userId, fieldName, masterKey);

      // Recreate decipher
      const iv = Buffer.from(encrypted.iv, "hex");
      const authTag = Buffer.from(encrypted.authTag, "hex");
      const ciphertext = Buffer.from(encrypted.ciphertext, "hex");

      const decipher = crypto.createDecipheriv(this.ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);

      // Decrypt
      let plaintext = decipher.update(ciphertext, "hex", "utf8");
      plaintext += decipher.final("utf8");

      return plaintext;
    } catch (error) {
      logger.error("Decryption failed", {
        userId,
        fieldName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Batch encrypt fields
   */
  static encryptFields(
    data: Record<string, string>,
    userId: string,
    masterKey: string,
  ): Record<string, EncryptedData> {
    const encrypted: Record<string, EncryptedData> = {};

    for (const [fieldName, plaintext] of Object.entries(data)) {
      if (plaintext) {
        encrypted[fieldName] = this.encrypt(
          plaintext,
          userId,
          fieldName,
          masterKey,
        );
      }
    }

    return encrypted;
  }

  /**
   * Batch decrypt fields
   */
  static decryptFields(
    data: Record<string, EncryptedData>,
    userId: string,
    masterKey: string,
  ): Record<string, string> {
    const decrypted: Record<string, string> = {};

    for (const [fieldName, encryptedData] of Object.entries(data)) {
      if (encryptedData) {
        decrypted[fieldName] = this.decrypt(
          encryptedData,
          userId,
          fieldName,
          masterKey,
        );
      }
    }

    return decrypted;
  }
}
```

## 3. Decryption Audit Logging (auditLog.ts)

```typescript
import { pool } from "../config/database";
import { logger } from "../services/logger";

export interface DecryptionAuditEntry {
  id: string;
  userId: string;
  fieldName: string;
  reason: string;
  requestorId?: string;
  requestorRole?: string;
  success: boolean;
  error?: string;
  ipAddress: string;
  userAgent: string;
  timestamp: Date;
}

export class DecryptionAudit {
  /**
   * Log decryption access
   */
  static async log(entry: DecryptionAuditEntry): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO pii_audit_log
         (id, user_id, field_name, reason, requestor_id, requestor_role, 
          success, error, ip_address, user_agent, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          entry.id,
          entry.userId,
          entry.fieldName,
          entry.reason,
          entry.requestorId,
          entry.requestorRole,
          entry.success,
          entry.error,
          entry.ipAddress,
          entry.userAgent,
          entry.timestamp,
        ],
      );
    } catch (error) {
      logger.error("Failed to log decryption", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get audit trail for user
   */
  static async getAuditTrail(
    userId: string,
    limit = 100,
  ): Promise<DecryptionAuditEntry[]> {
    const result = await pool.query(
      `SELECT * FROM pii_audit_log 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT $2`,
      [userId, limit],
    );

    return result.rows as DecryptionAuditEntry[];
  }

  /**
   * Detect suspicious access patterns
   */
  static async detectSuspiciousAccess(userId: string): Promise<boolean> {
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM pii_audit_log 
       WHERE user_id = $1 
       AND success = false 
       AND created_at > NOW() - INTERVAL '1 hour'`,
      [userId],
    );

    const failureCount = parseInt(result.rows[0].count || 0, 10);

    // Flag if more than 10 failed decryptions in 1 hour
    return failureCount > 10;
  }
}
```

## 4. ORM Field Decorator (models/encrypted.ts)

```typescript
import { PiiEncryption, EncryptedData } from "../crypto/encryption";
import { KeyManagement } from "../crypto/keyManagement";
import { DecryptionAudit } from "../crypto/auditLog";

/**
 * Property decorator for encrypted PII fields
 * Usage in model:
 *
 * class User {
 *   @Encrypted()
 *   phoneNumber: string;
 * }
 */
export function Encrypted() {
  return function (target: any, propertyKey: string) {
    const storageKey = `__encrypted_${propertyKey}`;
    const metadataKey = Symbol(`metadata_${propertyKey}`);

    Object.defineProperty(target, metadataKey, {
      value: {
        fieldName: propertyKey,
        storageKey,
        isEncrypted: true,
      },
      writable: false,
    });

    Object.defineProperty(target, propertyKey, {
      get(this: any) {
        return this[storageKey];
      },
      set(this: any, value: string) {
        this[storageKey] = value;
      },
      enumerable: true,
      configurable: true,
    });
  };
}

/**
 * Encrypt object before saving
 */
export async function encryptUserData(
  user: any,
  masterKey: string,
): Promise<any> {
  const encryptedFields = [
    "phoneNumber",
    "idNumber",
    "fullName",
    "address",
    "bankAccount",
  ];

  const encrypted: Record<string, EncryptedData> = {};

  for (const field of encryptedFields) {
    if (user[field]) {
      encrypted[field] = PiiEncryption.encrypt(
        user[field],
        user.id,
        field,
        masterKey,
      );
    }
  }

  // Store encrypted versions
  user.encrypted_phone = JSON.stringify(encrypted.phoneNumber);
  user.encrypted_id_number = JSON.stringify(encrypted.idNumber);
  // ... etc

  return user;
}

/**
 * Decrypt user data on retrieval
 */
export async function decryptUserData(
  user: any,
  masterKey: string,
  requestor: { id: string; role: string; ip: string; userAgent: string },
): Promise<any> {
  const encryptedFields = [
    { name: "phoneNumber", storageKey: "encrypted_phone" },
    { name: "idNumber", storageKey: "encrypted_id_number" },
    { name: "fullName", storageKey: "encrypted_full_name" },
    { name: "address", storageKey: "encrypted_address" },
    { name: "bankAccount", storageKey: "encrypted_bank_account" },
  ];

  for (const { name, storageKey } of encryptedFields) {
    if (user[storageKey]) {
      try {
        const encrypted = JSON.parse(user[storageKey]) as EncryptedData;
        user[name] = PiiEncryption.decrypt(encrypted, user.id, name, masterKey);

        // Log decryption access
        await DecryptionAudit.log({
          id: `${user.id}:${Date.now()}`,
          userId: user.id,
          fieldName: name,
          reason: "data_retrieval",
          requestorId: requestor.id,
          requestorRole: requestor.role,
          success: true,
          ipAddress: requestor.ip,
          userAgent: requestor.userAgent,
          timestamp: new Date(),
        });
      } catch (error) {
        // Log failure
        await DecryptionAudit.log({
          id: `${user.id}:${Date.now()}:fail`,
          userId: user.id,
          fieldName: name,
          reason: "data_retrieval",
          requestorId: requestor.id,
          requestorRole: requestor.role,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          ipAddress: requestor.ip,
          userAgent: requestor.userAgent,
          timestamp: new Date(),
        });

        // Don't include field on decryption failure
        user[name] = undefined;
      }
    }
  }

  return user;
}
```

## 5. Database Migration

```sql
-- migrations/010_encrypt_pii_data.sql

-- Create audit log table
CREATE TABLE IF NOT EXISTS pii_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  field_name VARCHAR(100) NOT NULL,
  reason VARCHAR(100) NOT NULL,
  requestor_id UUID REFERENCES users(id),
  requestor_role VARCHAR(50),
  success BOOLEAN DEFAULT true,
  error TEXT,
  ip_address INET,
  user_agent VARCHAR(500),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_pii_audit_user_created ON pii_audit_log(user_id, created_at DESC);
CREATE INDEX idx_pii_audit_field ON pii_audit_log(field_name);

-- Add encrypted field columns
ALTER TABLE users
ADD COLUMN IF NOT EXISTS encrypted_phone JSONB,
ADD COLUMN IF NOT EXISTS encrypted_id_number JSONB,
ADD COLUMN IF NOT EXISTS encrypted_full_name JSONB,
ADD COLUMN IF NOT EXISTS encrypted_address JSONB,
ADD COLUMN IF NOT EXISTS encrypted_bank_account JSONB;

-- Backup original fields (keep for 30 days during transition)
CREATE TABLE users_plaintext_backup AS
SELECT
  id,
  phone_number,
  id_number,
  full_name,
  address,
  bank_account,
  created_at
FROM users
WHERE phone_number IS NOT NULL
  OR id_number IS NOT NULL;

-- Encryption will happen in application code with key rotation
```

## Testing Strategy

```typescript
// src/crypto/__tests__/encryption.test.ts
import { PiiEncryption, EncryptedData } from "../encryption";
import { KeyManagement } from "../keyManagement";

describe("Encryption", () => {
  const masterKey = KeyManagement.generateMasterKey();
  const userId = "test-user-id";
  const fieldName = "phoneNumber";

  it("should encrypt and decrypt consistently", () => {
    const plaintext = "+1234567890";

    const encrypted = PiiEncryption.encrypt(
      plaintext,
      userId,
      fieldName,
      masterKey,
    );
    const decrypted = PiiEncryption.decrypt(
      encrypted,
      userId,
      fieldName,
      masterKey,
    );

    expect(decrypted).toBe(plaintext);
  });

  it("should generate unique ciphertexts", () => {
    const plaintext = "+1234567890";

    const enc1 = PiiEncryption.encrypt(plaintext, userId, fieldName, masterKey);
    const enc2 = PiiEncryption.encrypt(plaintext, userId, fieldName, masterKey);

    // Different IVs → different ciphertexts
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);

    // But both decrypt to same value
    const dec1 = PiiEncryption.decrypt(enc1, userId, fieldName, masterKey);
    const dec2 = PiiEncryption.decrypt(enc2, userId, fieldName, masterKey);

    expect(dec1).toBe(dec2);
  });

  it("should fail on tampering", () => {
    const plaintext = "+1234567890";
    const encrypted = PiiEncryption.encrypt(
      plaintext,
      userId,
      fieldName,
      masterKey,
    );

    // Tamper with ciphertext
    const tampered = {
      ...encrypted,
      ciphertext: encrypted.ciphertext.slice(0, -2) + "00",
    };

    expect(() =>
      PiiEncryption.decrypt(tampered, userId, fieldName, masterKey),
    ).toThrow();
  });

  it("should fail with wrong master key", () => {
    const plaintext = "+1234567890";
    const encrypted = PiiEncryption.encrypt(
      plaintext,
      userId,
      fieldName,
      masterKey,
    );

    const wrongKey = KeyManagement.generateMasterKey();

    expect(() =>
      PiiEncryption.decrypt(encrypted, userId, fieldName, wrongKey),
    ).toThrow();
  });
});
```

## Performance Considerations

```typescript
// Encryption overhead measurement
// Expected: <50ms per field encryption/decryption

import { performance } from "perf_hooks";

export async function benchmarkEncryption() {
  const masterKey = KeyManagement.generateMasterKey();
  const iterations = 1000;

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const plaintext = `+${Math.random() * 1e10}`;
    PiiEncryption.encrypt(plaintext, `user-${i}`, "phoneNumber", masterKey);
  }
  const encryptTime = (performance.now() - start) / iterations;

  console.log(`Encryption: ${encryptTime.toFixed(2)}ms per field`);

  // Expected output: ~5-15ms per field on modern hardware
}
```
