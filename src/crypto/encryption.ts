import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
  getCipherInfo,
  getCiphers,
} from "crypto";

export interface Encrypted {
  iv: string; // hex
  ciphertext: string; // hex
  authTag: string; // hex
}

/** The only cipher algorithm permitted for PII at rest (Issue #632). */
export const AES_GCM_ALGORITHM = "aes-256-gcm" as const;
/** AES-256 requires a 256-bit (32-byte) key. */
export const AES_KEY_LENGTH_BYTES = 32;
/** GCM recommendation: 96-bit (12-byte) IV. */
export const GCM_IV_LENGTH_BYTES = 12;
/** 128-bit GCM authentication tag. */
export const GCM_AUTH_TAG_LENGTH_BYTES = 16;

/** Algorithms this module will accept. Everything else is rejected. */
const ALLOWED_CIPHER_ALGORITHMS: readonly string[] = [AES_GCM_ALGORITHM];

/**
 * Cipher families that must never be used for PII. These are rejected even
 * when Node.js is capable of constructing them.
 */
const WEAK_CIPHER_PATTERNS: readonly RegExp[] = [
  /-ecb$/i, // ECB leaks plaintext structure
  /^aes-128/i, // 128-bit key — not AES-256
  /^aes-192/i, // 192-bit key — not AES-256
  /-cbc$/i, // unauthenticated encryption
  /-cfb/i,
  /-ofb/i,
  /-ctr$/i,
  /^des/i,
  /^3des/i,
  /^rc2/i,
  /^rc4/i,
  /^blowfish/i,
  /-wrap/i,
];

/**
 * Throws unless `algorithm` is an allow-listed, non-weak cipher.
 * Used to guarantee the module always operates on AES-256-GCM.
 */
export function assertCipherAlgorithm(algorithm: string): void {
  if (!ALLOWED_CIPHER_ALGORITHMS.includes(algorithm)) {
    throw new Error(
      `Unsupported cipher algorithm "${algorithm}". Only ${ALLOWED_CIPHER_ALGORITHMS.join(
        ", ",
      )} is permitted for PII encryption.`,
    );
  }

  const weakPattern = WEAK_CIPHER_PATTERNS.find((pattern) =>
    pattern.test(algorithm),
  );
  if (weakPattern) {
    throw new Error(
      `Weak cipher algorithm "${algorithm}" is not permitted for PII encryption.`,
    );
  }
}

/**
 * Asserts a key is exactly 256 bits. Guards against silently downgrading
 * AES-256 to a shorter key size.
 */
export function assertKeyLength(
  key: Buffer | Uint8Array | null | undefined,
  context = "AES-256-GCM key",
): void {
  if (!key || key.length !== AES_KEY_LENGTH_BYTES) {
    throw new Error(
      `${context} must be exactly ${AES_KEY_LENGTH_BYTES} bytes (256 bits), received ${
        key?.length ?? 0
      }`,
    );
  }
}

/**
 * Verifies the runtime can actually provide the requested cipher with the
 * expected key/IV length. Protects against a build that silently substitutes a
 * weaker cipher implementation.
 */
export function validateCipherAlgorithmSupport(
  algorithm: string = AES_GCM_ALGORITHM,
): void {
  assertCipherAlgorithm(algorithm);

  if (!getCiphers().includes(algorithm)) {
    throw new Error(
      `Cipher algorithm "${algorithm}" is not available in this Node.js build`,
    );
  }

  const info = getCipherInfo(algorithm);
  if (
    info &&
    (info.keyLength !== AES_KEY_LENGTH_BYTES ||
      info.ivLength !== GCM_IV_LENGTH_BYTES)
  ) {
    throw new Error(
      `Cipher "${algorithm}" reported unexpected parameters: keyLength=${
        info.keyLength
      } ivLength=${info.ivLength}. Expected keyLength=${AES_KEY_LENGTH_BYTES} ivLength=${GCM_IV_LENGTH_BYTES}.`,
    );
  }
}

/**
 * Startup validation for the PII encryption configuration. Call this during
 * application bootstrap to fail fast if the cipher cannot be trusted.
 */
export function validateEncryptionConfiguration(): {
  algorithm: string;
  keyLengthBytes: number;
} {
  validateCipherAlgorithmSupport(AES_GCM_ALGORITHM);
  return {
    algorithm: AES_GCM_ALGORITHM,
    keyLengthBytes: AES_KEY_LENGTH_BYTES,
  };
}

// Fail fast on module load (i.e. at application startup) if AES-256-GCM is not
// available or does not report the expected parameters.
validateCipherAlgorithmSupport();

/** Derive a 32-byte AES key from a password using a single SHA-256.
 * This is intentionally simple for tests/fuzzing. For production use a
 * proper KDF (PBKDF2/Argon2/ HKDF) with salt and iterations.
 */
export function deriveKey(password: string): Buffer {
  return createHash("sha256").update(password, "utf8").digest();
}

/** Encrypt a buffer with AES-256-GCM. Returns hex-encoded fields. */
export function encryptAesGcm(plaintext: Buffer, key: Buffer): Encrypted {
  assertKeyLength(key);
  const iv = randomBytes(GCM_IV_LENGTH_BYTES);
  const cipher = createCipheriv(AES_GCM_ALGORITHM, key, iv, {
    authTagLength: GCM_AUTH_TAG_LENGTH_BYTES,
  });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

/** Decrypt AES-256-GCM hex fields. Throws on auth failure. */
export function decryptAesGcm(enc: Encrypted, key: Buffer): Buffer {
  assertKeyLength(key);
  const iv = Buffer.from(enc.iv, "hex");
  const ciphertext = Buffer.from(enc.ciphertext, "hex");
  const authTag = Buffer.from(enc.authTag, "hex");
  const decipher = createDecipheriv(AES_GCM_ALGORITHM, key, iv, {
    authTagLength: GCM_AUTH_TAG_LENGTH_BYTES,
  });
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain;
}

export default {
  deriveKey,
  encryptAesGcm,
  decryptAesGcm,
  assertCipherAlgorithm,
  assertKeyLength,
  validateCipherAlgorithmSupport,
  validateEncryptionConfiguration,
  AES_GCM_ALGORITHM,
  AES_KEY_LENGTH_BYTES,
};
