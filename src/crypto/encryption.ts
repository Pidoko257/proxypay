import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "crypto";

export interface Encrypted {
  iv: string; // hex
  ciphertext: string; // hex
  authTag: string; // hex
}

/** Derive a 32-byte AES key from a password using a single SHA-256.
 * This is intentionally simple for tests/fuzzing. For production use a
 * proper KDF (PBKDF2/Argon2/ HKDF) with salt and iterations.
 */
export function deriveKey(password: string): Buffer {
  return createHash("sha256").update(password, "utf8").digest();
}

/** Encrypt a buffer with AES-256-GCM. Returns hex-encoded fields. */
export function encryptAesGcm(plaintext: Buffer, key: Buffer): Encrypted {
  if (key.length !== 32) throw new Error("key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
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
  if (key.length !== 32) throw new Error("key must be 32 bytes");
  const iv = Buffer.from(enc.iv, "hex");
  const ciphertext = Buffer.from(enc.ciphertext, "hex");
  const authTag = Buffer.from(enc.authTag, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain;
}

// ─── Key versioning & rotation ────────────────────────────────────────────────
//
// Versioned ciphertext is self-describing so old data keeps decrypting after a
// key rotation:
//
//   <version>:<iv_hex>:<authTag_hex>:<ciphertext_hex>
//
// The key ring is resolved dynamically at call time, which lets operators roll
// out a new key without a redeploy. Configure it with any combination of:
//
//   PII_ENCRYPTION_KEY=<secret>                       legacy / bootstrap key
//   PII_ENCRYPTION_KEY_V2=<secret>                    one env var per version
//   PII_ENCRYPTION_KEYS={"v1":"<s>","v2":"<s>"}       JSON map of versions
//   ACTIVE_PII_KEY_VERSION=v2                         key used for new data
//
// DB_ENCRYPTION_KEY / DB_ENCRYPTION_KEY_<VERSION> / DB_ENCRYPTION_KEYS are
// honoured as fallbacks so the PII key ring shares configuration with the
// utilities in src/utils/encryption.ts.

export const DEFAULT_KEY_VERSION = "legacy";

type VersionedParts = {
  version: string;
  iv: string;
  authTag: string;
  ciphertext: string;
};

function normaliseVersion(version: string): string {
  return version.trim().toLowerCase();
}

function parseKeyMap(raw: string | undefined, ring: Map<string, Buffer>): void {
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    for (const [version, material] of Object.entries(parsed)) {
      if (material) ring.set(normaliseVersion(version), deriveKey(material));
    }
  } catch (err) {
    console.error("[crypto] Failed to parse encryption key map:", err);
  }
}

/**
 * Resolves every configured encryption key into a versioned key ring.
 * Versions are lower-cased; the bootstrap key uses `DEFAULT_KEY_VERSION`.
 */
export function getKeyRing(): Map<string, Buffer> {
  const ring = new Map<string, Buffer>();

  const legacy =
    process.env.PII_ENCRYPTION_KEY || process.env.DB_ENCRYPTION_KEY;
  if (legacy) {
    ring.set(DEFAULT_KEY_VERSION, deriveKey(legacy));
  }

  parseKeyMap(process.env.PII_ENCRYPTION_KEYS, ring);
  parseKeyMap(process.env.DB_ENCRYPTION_KEYS, ring);

  const versionedPrefixes = ["PII_ENCRYPTION_KEY_", "DB_ENCRYPTION_KEY_"];
  for (const [name, value] of Object.entries(process.env)) {
    if (!value) continue;
    const prefix = versionedPrefixes.find((candidate) =>
      name.startsWith(candidate),
    );
    if (!prefix) continue;
    const version = normaliseVersion(name.slice(prefix.length));
    ring.set(version, deriveKey(value));
  }

  return ring;
}

/**
 * Returns the version new ciphertext should be encrypted with.
 * Falls back to the bootstrap key when the requested version is not configured.
 */
export function getActiveKeyVersion(
  ring: Map<string, Buffer> = getKeyRing(),
): string {
  const requested = normaliseVersion(
    process.env.ACTIVE_PII_KEY_VERSION ||
      process.env.ACTIVE_ENCRYPTION_KEY_VERSION ||
      "",
  );

  if (requested && ring.has(requested)) return requested;
  return DEFAULT_KEY_VERSION;
}

/** Serialises an encrypted payload with the key version that produced it. */
export function formatVersionedCiphertext(
  version: string,
  encrypted: Encrypted,
): string {
  return `${normaliseVersion(version)}:${encrypted.iv}:${encrypted.authTag}:${encrypted.ciphertext}`;
}

/** Parses `<version>:<iv>:<authTag>:<ciphertext>`, returning null when malformed. */
export function parseVersionedCiphertext(value: string): VersionedParts | null {
  if (!value) return null;
  const parts = value.split(":");
  if (parts.length !== 4) return null;
  const [version, iv, authTag, ciphertext] = parts;
  if (!/^[a-z0-9_-]+$/i.test(version)) return null;
  if (!/^[0-9a-f]+$/i.test(iv) || iv.length !== 24) return null; // 12 bytes hex
  if (!/^[0-9a-f]+$/i.test(authTag) || authTag.length !== 32) return null;
  if (!/^[0-9a-f]*$/i.test(ciphertext) || ciphertext.length % 2 !== 0)
    return null;

  return { version: normaliseVersion(version), iv, authTag, ciphertext };
}

/** True when `value` is a well-formed versioned ciphertext. */
export function isVersionedCiphertext(value: string): boolean {
  return parseVersionedCiphertext(value) !== null;
}

/**
 * Encrypts a value with the active (or explicitly requested) key version.
 * The returned ciphertext carries its version prefix so it stays decryptable
 * after the active key rotates.
 */
export function encryptVersioned(
  plaintext: Buffer | string,
  version?: string,
): string {
  const ring = getKeyRing();
  const target = normaliseVersion(version ?? getActiveKeyVersion(ring));
  const key = ring.get(target);

  if (!key) {
    throw new Error(
      `No encryption key configured for version "${target}". Configure PII_ENCRYPTION_KEY_${target.toUpperCase()} or PII_ENCRYPTION_KEYS.`,
    );
  }

  const buffer =
    typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  return formatVersionedCiphertext(target, encryptAesGcm(buffer, key));
}

/**
 * Decrypts a versioned ciphertext. The declared version is tried first and the
 * remaining keys in the ring are used as fallbacks, keeping data readable while
 * a rotation is still in progress.
 */
export function decryptVersioned(payload: string): Buffer {
  const parsed = parseVersionedCiphertext(payload);
  if (!parsed) {
    throw new Error(
      "Invalid versioned ciphertext — expected version:iv:authTag:ciphertext",
    );
  }

  const ring = getKeyRing();
  const order = [
    parsed.version,
    ...Array.from(ring.keys()).filter((version) => version !== parsed.version),
  ];

  for (const version of order) {
    const key = ring.get(version);
    if (!key) continue;
    try {
      return decryptAesGcm(
        {
          iv: parsed.iv,
          authTag: parsed.authTag,
          ciphertext: parsed.ciphertext,
        },
        key,
      );
    } catch {
      // Try the next key in the ring.
    }
  }

  throw new Error(
    `Unable to decrypt versioned ciphertext for version "${parsed.version}" with the configured key ring.`,
  );
}

export interface CiphertextRotationResult {
  /** Ciphertext to persist (unchanged when no rotation was required). */
  value: string;
  /** Version the input was decrypted with, or null for unsupported input. */
  fromVersion: string | null;
  /** Version the ciphertext is now encrypted with. */
  toVersion: string;
  /** True when `value` differs from the input. */
  rotated: boolean;
}

/**
 * Re-encrypts one ciphertext with the active (or requested) key version.
 * This is the primitive used by the key rotation migration script.
 */
export function rotateCiphertext(
  payload: string,
  targetVersion?: string,
): CiphertextRotationResult {
  const ring = getKeyRing();
  const target = normaliseVersion(targetVersion ?? getActiveKeyVersion(ring));
  const targetKey = ring.get(target);

  if (!targetKey) {
    throw new Error(`No encryption key configured for version "${target}".`);
  }

  const parsed = parseVersionedCiphertext(payload);
  if (parsed) {
    if (parsed.version === target) {
      return {
        value: payload,
        fromVersion: parsed.version,
        toVersion: target,
        rotated: false,
      };
    }

    const plaintext = decryptVersioned(payload);
    return {
      value: formatVersionedCiphertext(
        target,
        encryptAesGcm(plaintext, targetKey),
      ),
      fromVersion: parsed.version,
      toVersion: target,
      rotated: true,
    };
  }

  // Un-versioned (legacy) ciphertext: try every key in the ring until one
  // authenticates, then persist the value in the versioned format.
  const parts = payload.split(":");
  if (parts.length === 3) {
    const [iv, authTag, ciphertext] = parts;
    for (const version of ring.keys()) {
      try {
        const plaintext = decryptAesGcm(
          { iv, authTag, ciphertext },
          ring.get(version)!,
        );
        return {
          value: formatVersionedCiphertext(
            target,
            encryptAesGcm(plaintext, targetKey),
          ),
          fromVersion: version,
          toVersion: target,
          rotated: true,
        };
      } catch {
        // Try the next key in the ring.
      }
    }
  }

  throw new Error(
    "Unable to rotate ciphertext: value is neither versioned nor a decryptable legacy payload.",
  );
}

export interface KeyRingValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validates the key ring / active-version configuration at startup so a
 * misconfigured rotation fails fast instead of silently losing access to PII.
 */
export function validateKeyRingConfig(
  ring: Map<string, Buffer> = getKeyRing(),
): KeyRingValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (ring.size === 0) {
    errors.push(
      "No encryption keys configured. Set PII_ENCRYPTION_KEY or PII_ENCRYPTION_KEYS.",
    );
  }

  const requested = normaliseVersion(
    process.env.ACTIVE_PII_KEY_VERSION ||
      process.env.ACTIVE_ENCRYPTION_KEY_VERSION ||
      "",
  );

  if (requested && !ring.has(requested)) {
    errors.push(
      `ACTIVE_PII_KEY_VERSION="${requested}" is not present in the key ring.`,
    );
  }

  if (!process.env.PII_ENCRYPTION_KEY && !process.env.PII_ENCRYPTION_KEYS) {
    warnings.push(
      "Falling back to DB_ENCRYPTION_KEY* for the PII key ring. Prefer distinct PII_ENCRYPTION_* key material.",
    );
  }

  if (ring.size === 1) {
    warnings.push(
      "Only one encryption key version is configured. Keep the previous version in the ring so rotated data stays readable.",
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}

export default {
  deriveKey,
  encryptAesGcm,
  decryptAesGcm,
  getKeyRing,
  getActiveKeyVersion,
  encryptVersioned,
  decryptVersioned,
  rotateCiphertext,
  validateKeyRingConfig,
};
