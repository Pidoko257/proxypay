/**
 * Tests for AES-256-GCM PII encryption utilities
 *
 * Covers:
 *  - Encrypted value in DB does not match plaintext
 *  - Decrypted value matches original plaintext
 *  - Wrong key fails decryption with a clear error
 *  - IV is unique across multiple encryptions
 *  - Transparent middleware helpers (encryptPiiFields / decryptPiiFields)
 *  - Per-user key derivation produces different ciphertext than global key
 */

import crypto from "crypto";
import {
  encryptAES,
  decryptAES,
  deriveKey,
  deriveUserKey,
  serializePayload,
  deserializePayload,
  encryptField,
  decryptField,
  encryptFieldForUser,
  decryptFieldForUser,
  encrypt,
  decrypt,
} from "../utils/encryption";
import {
  encryptPiiFields,
  decryptPiiFields,
  encryptPiiFieldsForUser,
  decryptPiiFieldsForUser,
} from "../middleware/piiEncryption";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKey(): Buffer {
  return crypto.randomBytes(32);
}

// ---------------------------------------------------------------------------
// Core encrypt / decrypt
// ---------------------------------------------------------------------------

describe("AES-256-GCM encrypt / decrypt", () => {
  it("encrypted value does not match plaintext", () => {
    const key = makeKey();
    const plaintext = "Alice Dupont";
    const payload = encryptAES(plaintext, key);

    expect(payload.ciphertext).not.toBe(plaintext);
    expect(payload.ciphertext).not.toContain(plaintext);
  });

  it("decrypted value matches original plaintext", () => {
    const key = makeKey();
    const plaintext = "123 Main Street, Douala";
    const payload = encryptAES(plaintext, key);
    expect(decryptAES(payload, key)).toBe(plaintext);
  });

  it("wrong key throws a clear, catchable error", () => {
    const key = makeKey();
    const wrongKey = makeKey();
    const payload = encryptAES("sensitive-id-number", key);

    expect(() => decryptAES(payload, wrongKey)).toThrow(
      /PII decryption failed/,
    );
  });

  it("IV is unique across multiple encryptions of the same plaintext", () => {
    const key = makeKey();
    const plaintext = "same plaintext";
    const ivs = new Set<string>();

    for (let i = 0; i < 100; i++) {
      const payload = encryptAES(plaintext, key);
      ivs.add(payload.iv);
    }

    // All 100 IVs must be distinct
    expect(ivs.size).toBe(100);
  });

  it("same plaintext produces different ciphertext each time (probabilistic encryption)", () => {
    const key = makeKey();
    const plaintext = "repeat";
    const p1 = encryptAES(plaintext, key);
    const p2 = encryptAES(plaintext, key);

    expect(p1.ciphertext).not.toBe(p2.ciphertext);
    expect(p1.iv).not.toBe(p2.iv);
  });

  it("rejects keys that are not 32 bytes", () => {
    const shortKey = crypto.randomBytes(16);
    expect(() => encryptAES("test", shortKey)).toThrow(/32 bytes/);
  });

  it("throws on tampered ciphertext", () => {
    const key = makeKey();
    const payload = encryptAES("original", key);
    // Flip a byte in the ciphertext
    const tampered = { ...payload, ciphertext: "00" + payload.ciphertext.slice(2) };
    expect(() => decryptAES(tampered, key)).toThrow(/PII decryption failed/);
  });

  it("throws on tampered auth tag", () => {
    const key = makeKey();
    const payload = encryptAES("original", key);
    const tampered = { ...payload, authTag: "00".repeat(16) };
    expect(() => decryptAES(tampered, key)).toThrow(/PII decryption failed/);
  });
});

// ---------------------------------------------------------------------------
// Serialisation round-trip
// ---------------------------------------------------------------------------

describe("serializePayload / deserializePayload", () => {
  it("round-trips correctly", () => {
    const key = makeKey();
    const payload = encryptAES("test value", key);
    const serialised = serializePayload(payload);
    const deserialised = deserializePayload(serialised);

    expect(deserialised.iv).toBe(payload.iv);
    expect(deserialised.authTag).toBe(payload.authTag);
    expect(deserialised.ciphertext).toBe(payload.ciphertext);
  });

  it("throws on malformed serialised string", () => {
    expect(() => deserializePayload("notvalid")).toThrow(/Invalid encrypted payload/);
    expect(() => deserializePayload("a:b")).toThrow(/Invalid encrypted payload/);
  });
});

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

describe("deriveKey / deriveUserKey", () => {
  it("produces a 32-byte key", () => {
    const key = deriveKey("some-master-secret");
    expect(key.length).toBe(32);
  });

  it("same input always produces the same key (deterministic)", () => {
    const k1 = deriveKey("master", "context");
    const k2 = deriveKey("master", "context");
    expect(k1.equals(k2)).toBe(true);
  });

  it("different info labels produce different keys (domain separation)", () => {
    const k1 = deriveKey("master", "context-a");
    const k2 = deriveKey("master", "context-b");
    expect(k1.equals(k2)).toBe(false);
  });

  it("per-user keys differ from each other and from the global key", () => {
    const global = deriveKey(process.env.DB_ENCRYPTION_KEY || "dev-key");
    const userA = deriveUserKey("user-id-aaa");
    const userB = deriveUserKey("user-id-bbb");

    expect(global.equals(userA)).toBe(false);
    expect(global.equals(userB)).toBe(false);
    expect(userA.equals(userB)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Convenience field helpers
// ---------------------------------------------------------------------------

describe("encryptField / decryptField (global key)", () => {
  it("null/undefined/empty pass through unchanged", () => {
    expect(encryptField(null)).toBeNull();
    expect(encryptField(undefined)).toBeUndefined();
    expect(encryptField("")).toBe("");
    expect(decryptField(null)).toBeNull();
    expect(decryptField(undefined)).toBeUndefined();
    expect(decryptField("")).toBe("");
  });

  it("round-trips a non-empty string", () => {
    const plaintext = "Jean-Pierre Mbeki";
    const encrypted = encryptField(plaintext) as string;
    expect(encrypted).not.toBe(plaintext);
    expect(decryptField(encrypted)).toBe(plaintext);
  });
});

describe("encryptFieldForUser / decryptFieldForUser (per-user key)", () => {
  it("round-trips correctly for a given user", () => {
    const userId = "user-123";
    const plaintext = "456 Rue de la Paix";
    const encrypted = encryptFieldForUser(plaintext, userId) as string;
    expect(encrypted).not.toBe(plaintext);
    expect(decryptFieldForUser(encrypted, userId)).toBe(plaintext);
  });

  it("different users produce different ciphertext for the same plaintext", () => {
    const plaintext = "same address";
    const enc1 = encryptFieldForUser(plaintext, "user-1") as string;
    const enc2 = encryptFieldForUser(plaintext, "user-2") as string;
    expect(enc1).not.toBe(enc2);
  });

  it("wrong user ID fails decryption", () => {
    const plaintext = "ID-987654";
    const encrypted = encryptFieldForUser(plaintext, "user-correct") as string;
    expect(() => decryptFieldForUser(encrypted, "user-wrong")).toThrow(/PII decryption failed/);
  });
});

// ---------------------------------------------------------------------------
// Transparent PII middleware
// ---------------------------------------------------------------------------

describe("encryptPiiFields / decryptPiiFields", () => {
  it("encrypts name, address, id_number and leaves other fields untouched", () => {
    const row = {
      id: "abc-123",
      user_id: "user-456",
      name: "Marie Curie",
      address: "1 Rue Pierre Curie",
      id_number: "FR-1234567",
      kyc_level: "full",
    };

    const encrypted = encryptPiiFields(row);

    expect(encrypted.id).toBe("abc-123");
    expect(encrypted.kyc_level).toBe("full");
    expect(encrypted.name).not.toBe("Marie Curie");
    expect(encrypted.address).not.toBe("1 Rue Pierre Curie");
    expect(encrypted.id_number).not.toBe("FR-1234567");
  });

  it("decrypts back to original plaintext", () => {
    const row = { name: "Marie Curie", address: "1 Rue Pierre Curie", id_number: "FR-1234567" };
    const encrypted = encryptPiiFields(row);
    const decrypted = decryptPiiFields(encrypted);

    expect(decrypted.name).toBe("Marie Curie");
    expect(decrypted.address).toBe("1 Rue Pierre Curie");
    expect(decrypted.id_number).toBe("FR-1234567");
  });

  it("handles null PII fields gracefully", () => {
    const row = { name: null, address: undefined, id_number: "" };
    const encrypted = encryptPiiFields(row);
    const decrypted = decryptPiiFields(encrypted);

    expect(decrypted.name).toBeNull();
    expect(decrypted.address).toBeUndefined();
    expect(decrypted.id_number).toBe("");
  });
});

describe("encryptPiiFieldsForUser / decryptPiiFieldsForUser", () => {
  it("round-trips with per-user key", () => {
    const userId = "user-789";
    const row = { name: "Amara Diallo", address: "Dakar, Senegal", id_number: "SN-99887" };
    const encrypted = encryptPiiFieldsForUser(row, userId);
    const decrypted = decryptPiiFieldsForUser(encrypted, userId);

    expect(decrypted.name).toBe("Amara Diallo");
    expect(decrypted.address).toBe("Dakar, Senegal");
    expect(decrypted.id_number).toBe("SN-99887");
  });

  it("wrong user ID fails decryption on PII row", () => {
    const row = { name: "Amara Diallo", address: "Dakar", id_number: "SN-99887" };
    const encrypted = encryptPiiFieldsForUser(row, "user-correct");
    expect(() => decryptPiiFieldsForUser(encrypted, "user-wrong")).toThrow(/PII decryption failed/);
  });
});

describe("zero-downtime key rotation / fallback keys support", () => {
  const originalEnvKey = process.env.DB_ENCRYPTION_KEY;

  afterEach(() => {
    process.env.DB_ENCRYPTION_KEY = originalEnvKey;
    delete process.env.DB_ENCRYPTION_KEYS_FALLBACK;
  });

  it("decrypts global key PII with fallback keys when master key has rotated", () => {
    const oldKey = "old-encryption-key-32-chars-long";
    const newKey = "new-encryption-key-32-chars-long";
    
    // Encrypt with old key
    process.env.DB_ENCRYPTION_KEY = oldKey;
    const plaintext = "Sensitive Financial Info";
    const encrypted = encryptField(plaintext);

    // Rotate to new key, old key becomes fallback
    process.env.DB_ENCRYPTION_KEY = newKey;
    process.env.DB_ENCRYPTION_KEYS_FALLBACK = oldKey;

    // Decrypt should succeed seamlessly
    const decrypted = decryptField(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("decrypts per-user key PII with fallback keys when master key has rotated", () => {
    const oldKey = "old-encryption-key-32-chars-long";
    const newKey = "new-encryption-key-32-chars-long";
    const userId = "user-abc-123";

    // Encrypt with old key
    process.env.DB_ENCRYPTION_KEY = oldKey;
    const plaintext = "Sensitive User PII";
    const encrypted = encryptFieldForUser(plaintext, userId);

    // Rotate to new key, old key becomes fallback
    process.env.DB_ENCRYPTION_KEY = newKey;
    process.env.DB_ENCRYPTION_KEYS_FALLBACK = oldKey;

    // Decrypt should succeed seamlessly
    const decrypted = decryptFieldForUser(encrypted, userId);
    expect(decrypted).toBe(plaintext);
  });

  it("decrypts legacy shim encrypted PII with fallback keys when master key has rotated", () => {
    const oldKey = "old-encryption-key-32-chars-long";
    const newKey = "new-encryption-key-32-chars-long";

    // Encrypt with old key
    process.env.DB_ENCRYPTION_KEY = oldKey;
    const plaintext = "Legacy encrypted phone";
    const encrypted = encrypt(plaintext);

    // Rotate to new key, old key becomes fallback
    process.env.DB_ENCRYPTION_KEY = newKey;
    process.env.DB_ENCRYPTION_KEYS_FALLBACK = oldKey;

    // Decrypt should succeed seamlessly
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("fails decryption if neither master key nor fallback keys can decrypt it", () => {
    const oldKey = "old-encryption-key-32-chars-long";
    const newKey = "new-encryption-key-32-chars-long";
    const wrongKey = "wrong-encryption-key-32-chars-lo";

    process.env.DB_ENCRYPTION_KEY = oldKey;
    const encrypted = encryptField("some data");

    // Rotate to new key, fallback to wrong key
    process.env.DB_ENCRYPTION_KEY = newKey;
    process.env.DB_ENCRYPTION_KEYS_FALLBACK = wrongKey;

    expect(() => decryptField(encrypted)).toThrow(/PII decryption failed/);
  });
});

// ---------------------------------------------------------------------------
// Email and Phone Number PII Fields (GDPR/CCPA)
// ---------------------------------------------------------------------------

describe("Email and Phone Number PII Encryption", () => {
  describe("Global key encryption for contact fields", () => {
    it("encrypts email addresses correctly", () => {
      const email = "alice@example.com";
      const encrypted = encryptField(email) as string;
      expect(encrypted).not.toBe(email);
      expect(encrypted).not.toContain("@");
      expect(decryptField(encrypted)).toBe(email);
    });

    it("encrypts phone numbers correctly", () => {
      const phone = "+237671234567";
      const encrypted = encryptField(phone) as string;
      expect(encrypted).not.toBe(phone);
      expect(encrypted).not.toContain("+237");
      expect(decryptField(encrypted)).toBe(phone);
    });

    it("handles international phone formats", () => {
      const phones = [
        "+237671234567",    // Cameroon
        "+441632960000",    // UK
        "+33123456789",     // France
        "0612345678",       // France (domestic)
      ];

      for (const phone of phones) {
        const encrypted = encryptField(phone) as string;
        expect(decryptField(encrypted)).toBe(phone);
      }
    });

    it("handles various email formats", () => {
      const emails = [
        "alice@example.com",
        "user.name+tag@example.co.uk",
        "test_email@subdomain.example.com",
        "user123@domain.org",
      ];

      for (const email of emails) {
        const encrypted = encryptField(email) as string;
        expect(decryptField(encrypted)).toBe(email);
      }
    });
  });

  describe("Per-user key encryption for contact fields", () => {
    it("encrypts email with per-user key", () => {
      const userId = "user-123";
      const email = "alice@example.com";
      const encrypted = encryptFieldForUser(email, userId) as string;
      expect(encrypted).not.toBe(email);
      expect(decryptFieldForUser(encrypted, userId)).toBe(email);
    });

    it("encrypts phone with per-user key", () => {
      const userId = "user-456";
      const phone = "+237671234567";
      const encrypted = encryptFieldForUser(phone, userId) as string;
      expect(encrypted).not.toBe(phone);
      expect(decryptFieldForUser(encrypted, userId)).toBe(phone);
    });

    it("same email produces different ciphertext for different users (data isolation)", () => {
      const email = "alice@example.com";
      const enc1 = encryptFieldForUser(email, "user-1") as string;
      const enc2 = encryptFieldForUser(email, "user-2") as string;
      expect(enc1).not.toBe(enc2);
    });
  });

  describe("Contact fields in PII middleware", () => {
    it("encrypts email and phone_number alongside existing PII fields", () => {
      const row = {
        id: "merchant-123",
        name: "Acme Corp",
        email: "contact@acme.com",
        phone_number: "+237671234567",
        address: "123 Business St",
        id_number: "RCCM-CM2024001",
        status: "active",
      };

      const encrypted = encryptPiiFields(row);

      // Non-PII fields unchanged
      expect(encrypted.id).toBe("merchant-123");
      expect(encrypted.status).toBe("active");

      // All PII fields encrypted
      expect(encrypted.name).not.toBe("Acme Corp");
      expect(encrypted.email).not.toBe("contact@acme.com");
      expect(encrypted.phone_number).not.toBe("+237671234567");
      expect(encrypted.address).not.toBe("123 Business St");
      expect(encrypted.id_number).not.toBe("RCCM-CM2024001");
    });

    it("decrypts email and phone_number correctly", () => {
      const row = {
        name: "Acme Corp",
        email: "contact@acme.com",
        phone_number: "+237671234567",
        address: "123 Business St",
        id_number: "RCCM-CM2024001",
      };

      const encrypted = encryptPiiFields(row);
      const decrypted = decryptPiiFields(encrypted);

      expect(decrypted.name).toBe("Acme Corp");
      expect(decrypted.email).toBe("contact@acme.com");
      expect(decrypted.phone_number).toBe("+237671234567");
      expect(decrypted.address).toBe("123 Business St");
      expect(decrypted.id_number).toBe("RCCM-CM2024001");
    });

    it("handles null and undefined email/phone gracefully", () => {
      const row = {
        name: "User",
        email: null,
        phone_number: undefined,
        address: "Some Address",
      };

      const encrypted = encryptPiiFields(row);
      const decrypted = decryptPiiFields(encrypted);

      expect(decrypted.email).toBeNull();
      expect(decrypted.phone_number).toBeUndefined();
      expect(decrypted.name).toBe("User");
      expect(decrypted.address).toBe("Some Address");
    });

    it("handles empty string email/phone correctly", () => {
      const row = {
        name: "User",
        email: "",
        phone_number: "",
        address: "Some Address",
      };

      const encrypted = encryptPiiFields(row);
      const decrypted = decryptPiiFields(encrypted);

      expect(decrypted.email).toBe("");
      expect(decrypted.phone_number).toBe("");
      expect(decrypted.name).toBe("User");
    });
  });

  describe("User contact data (users table)", () => {
    it("encrypts a typical user record with phone_number and email", () => {
      const user = {
        id: "user-999",
        phone_number: "+237671234567",
        email: "alice@example.com",
        kyc_level: "full",
        created_at: "2024-01-01T00:00:00Z",
      };

      const encrypted = encryptPiiFields(user);
      expect(encrypted.phone_number).not.toBe(user.phone_number);
      expect(encrypted.email).not.toBe(user.email);
      expect(encrypted.kyc_level).toBe("full");

      const decrypted = decryptPiiFields(encrypted);
      expect(decrypted.phone_number).toBe("+237671234567");
      expect(decrypted.email).toBe("alice@example.com");
    });
  });

  describe("Merchant contact data (merchants table)", () => {
    it("encrypts a typical merchant record with all PII fields", () => {
      const merchant = {
        id: "merchant-123",
        name: "Acme Corporation",
        email: "legal@acme.com",
        phone_number: "+237670555555",
        address: "123 Business Boulevard",
        country: "CM",
        status: "active",
        kyc_status: "verified",
      };

      const encrypted = encryptPiiFields(merchant);

      // Check non-PII fields
      expect(encrypted.id).toBe("merchant-123");
      expect(encrypted.country).toBe("CM");
      expect(encrypted.status).toBe("active");
      expect(encrypted.kyc_status).toBe("verified");

      // Check PII fields are encrypted
      expect(encrypted.name).not.toBe("Acme Corporation");
      expect(encrypted.email).not.toBe("legal@acme.com");
      expect(encrypted.phone_number).not.toBe("+237670555555");
      expect(encrypted.address).not.toBe("123 Business Boulevard");

      // Verify decryption
      const decrypted = decryptPiiFields(encrypted);
      expect(decrypted.name).toBe("Acme Corporation");
      expect(decrypted.email).toBe("legal@acme.com");
      expect(decrypted.phone_number).toBe("+237670555555");
      expect(decrypted.address).toBe("123 Business Boulevard");
    });
  });

  describe("Transaction phone data (transactions table)", () => {
    it("encrypts a typical transaction with phone_number", () => {
      const transaction = {
        id: "txn-456",
        reference_number: "REF-2024-001",
        type: "deposit",
        phone_number: "+237671234567",
        status: "completed",
        amount: "100.00",
      };

      const encrypted = encryptPiiFields(transaction);
      expect(encrypted.phone_number).not.toBe("+237671234567");
      expect(encrypted.reference_number).toBe("REF-2024-001");
      expect(encrypted.status).toBe("completed");

      const decrypted = decryptPiiFields(encrypted);
      expect(decrypted.phone_number).toBe("+237671234567");
    });
  });
});
