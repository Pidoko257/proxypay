import {
  generateEd25519Keypair,
  signPayloadEd25519,
  verifySignatureEd25519,
  getPublicKeyFromPrivateEd25519,
} from "../../src/crypto/ed25519Webhook";
import { verifyWebhookSignature } from "../../src/services/webhook";

describe("Ed25519 Webhook Signing and Verification", () => {
  let privateKeyHex: string;
  let publicKeyHex: string;
  const testPayload = JSON.stringify({
    event: "transaction.completed",
    timestamp: "2026-07-29T01:03:47Z",
    data: { id: "tx_123", amount: "1000" },
  });

  beforeAll(() => {
    // Generate a fresh keypair for testing
    const keypair = generateEd25519Keypair();
    privateKeyHex = keypair.privateKeyHex;
    publicKeyHex = keypair.publicKeyHex;
  });

  describe("generateEd25519Keypair", () => {
    it("should generate a valid Ed25519 keypair", () => {
      const keypair = generateEd25519Keypair();
      expect(keypair.privateKeyHex).toBeDefined();
      expect(keypair.publicKeyHex).toBeDefined();
      expect(keypair.privateKeyHex.length).toBe(64); // 32 bytes in hex = 64 chars
      expect(keypair.publicKeyHex.length).toBe(64); // 32 bytes in hex = 64 chars
    });

    it("should generate different keypairs each time", () => {
      const kp1 = generateEd25519Keypair();
      const kp2 = generateEd25519Keypair();
      expect(kp1.privateKeyHex).not.toEqual(kp2.privateKeyHex);
      expect(kp1.publicKeyHex).not.toEqual(kp2.publicKeyHex);
    });
  });

  describe("signPayloadEd25519", () => {
    it("should sign a payload string and return base64 signature", () => {
      const signature = signPayloadEd25519(testPayload, privateKeyHex);
      expect(signature).toBeDefined();
      expect(typeof signature).toBe("string");
      // Base64 signature should be longer than 80 chars (64-byte signature = ~88 chars in base64)
      expect(signature.length).toBeGreaterThan(80);
    });

    it("should sign a buffer payload", () => {
      const payloadBuffer = Buffer.from(testPayload);
      const signature = signPayloadEd25519(payloadBuffer, privateKeyHex);
      expect(signature).toBeDefined();
      expect(typeof signature).toBe("string");
    });

    it("should produce deterministic signatures", () => {
      const sig1 = signPayloadEd25519(testPayload, privateKeyHex);
      const sig2 = signPayloadEd25519(testPayload, privateKeyHex);
      expect(sig1).toEqual(sig2); // Ed25519 is deterministic
    });

    it("should produce different signatures for different payloads", () => {
      const payload1 = JSON.stringify({ amount: "1000" });
      const payload2 = JSON.stringify({ amount: "2000" });
      const sig1 = signPayloadEd25519(payload1, privateKeyHex);
      const sig2 = signPayloadEd25519(payload2, privateKeyHex);
      expect(sig1).not.toEqual(sig2);
    });

    it("should throw when given an invalid private key", () => {
      const invalidKey = "invalid_key_that_is_too_short";
      expect(() => signPayloadEd25519(testPayload, invalidKey)).toThrow();
    });
  });

  describe("verifySignatureEd25519", () => {
    let validSignature: string;

    beforeAll(() => {
      validSignature = signPayloadEd25519(testPayload, privateKeyHex);
    });

    it("should verify a valid signature with string payload", () => {
      const isValid = verifySignatureEd25519(
        testPayload,
        validSignature,
        publicKeyHex,
      );
      expect(isValid).toBe(true);
    });

    it("should verify a valid signature with buffer payload", () => {
      const payloadBuffer = Buffer.from(testPayload);
      const isValid = verifySignatureEd25519(
        payloadBuffer,
        validSignature,
        publicKeyHex,
      );
      expect(isValid).toBe(true);
    });

    it("should reject invalid signature", () => {
      const tamperedPayload = JSON.stringify({
        event: "transaction.failed",
        timestamp: "2026-07-29T01:03:47Z",
      });
      const isValid = verifySignatureEd25519(
        tamperedPayload,
        validSignature,
        publicKeyHex,
      );
      expect(isValid).toBe(false);
    });

    it("should reject malformed signature", () => {
      const isValid = verifySignatureEd25519(
        testPayload,
        "invalid_base64_!!!",
        publicKeyHex,
      );
      expect(isValid).toBe(false);
    });

    it("should reject signature with wrong length", () => {
      const tooShortSig = "dGVzdA=="; // "test" in base64
      const isValid = verifySignatureEd25519(
        testPayload,
        tooShortSig,
        publicKeyHex,
      );
      expect(isValid).toBe(false);
    });

    it("should reject signature with wrong public key", () => {
      const wrongKeypair = generateEd25519Keypair();
      const isValid = verifySignatureEd25519(
        testPayload,
        validSignature,
        wrongKeypair.publicKeyHex,
      );
      expect(isValid).toBe(false);
    });

    it("should return false for invalid public key hex", () => {
      const isValid = verifySignatureEd25519(
        testPayload,
        validSignature,
        "not_a_valid_hex_string",
      );
      expect(isValid).toBe(false);
    });
  });

  describe("getPublicKeyFromPrivateEd25519", () => {
    it("should derive the correct public key from private key", () => {
      const derived = getPublicKeyFromPrivateEd25519(privateKeyHex);
      expect(derived).toEqual(publicKeyHex);
    });

    it("should derive a public key of correct length", () => {
      const derived = getPublicKeyFromPrivateEd25519(privateKeyHex);
      expect(derived.length).toBe(64); // 32 bytes in hex
    });

    it("should throw on invalid private key", () => {
      expect(() => getPublicKeyFromPrivateEd25519("invalid_key")).toThrow();
    });
  });

  describe("verifyWebhookSignature (integration)", () => {
    let validEd25519Sig: string;
    let validHmacSig: string;
    const hmacSecret = "my-webhook-secret";

    beforeAll(() => {
      // Ed25519 signature
      validEd25519Sig = signPayloadEd25519(testPayload, privateKeyHex);

      // HMAC signature (for backward compatibility testing)
      const crypto = require("crypto");
      validHmacSig = `sha256=${crypto
        .createHmac("sha256", hmacSecret)
        .update(testPayload)
        .digest("hex")}`;
    });

    it("should verify Ed25519 signed webhooks", () => {
      const signatureHeader = `ed25519:${validEd25519Sig}`;
      const isValid = verifyWebhookSignature(
        testPayload,
        signatureHeader,
        publicKeyHex,
      );
      expect(isValid).toBe(true);
    });

    it("should verify HMAC-SHA256 signed webhooks (backward compatibility)", () => {
      const isValid = verifyWebhookSignature(
        testPayload,
        validHmacSig,
        hmacSecret,
      );
      expect(isValid).toBe(true);
    });

    it("should reject invalid Ed25519 signatures", () => {
      const invalidSig = `ed25519:${Buffer.alloc(64).toString("base64")}`;
      const isValid = verifyWebhookSignature(
        testPayload,
        invalidSig,
        publicKeyHex,
      );
      expect(isValid).toBe(false);
    });

    it("should reject unknown signature formats", () => {
      const unknownFormat = "unknown:signature_data";
      const isValid = verifyWebhookSignature(
        testPayload,
        unknownFormat,
        publicKeyHex,
      );
      expect(isValid).toBe(false);
    });

    it("should handle buffer payloads", () => {
      const payloadBuffer = Buffer.from(testPayload);
      const signatureHeader = `ed25519:${validEd25519Sig}`;
      const isValid = verifyWebhookSignature(
        payloadBuffer,
        signatureHeader,
        publicKeyHex,
      );
      expect(isValid).toBe(true);
    });

    it("should reject tampered payloads", () => {
      const tamperedPayload = testPayload.replace("1000", "9999");
      const signatureHeader = `ed25519:${validEd25519Sig}`;
      const isValid = verifyWebhookSignature(
        tamperedPayload,
        signatureHeader,
        publicKeyHex,
      );
      expect(isValid).toBe(false);
    });
  });

  describe("WebhookService integration with Ed25519", () => {
    it("should sign payloads with Ed25519 when enabled", () => {
      const { WebhookService } = require("../../src/services/webhook");
      const service = new WebhookService({
        webhookUrl: "https://example.com/webhook",
        webhookPrivateKeyEd25519: privateKeyHex,
        useEd25519: true,
      });

      const signature = service.signPayload(testPayload);
      expect(signature).toMatch(/^ed25519:.+$/);

      // Extract and verify the signature
      const sig = signature.substring(8);
      const isValid = verifySignatureEd25519(testPayload, sig, publicKeyHex);
      expect(isValid).toBe(true);
    });

    it("should return public key from WebhookService", () => {
      const { WebhookService } = require("../../src/services/webhook");
      const service = new WebhookService({
        webhookUrl: "https://example.com/webhook",
        webhookPrivateKeyEd25519: privateKeyHex,
        useEd25519: true,
      });

      const publicKey = service.getEd25519PublicKey();
      expect(publicKey).toEqual(publicKeyHex);
    });

    it("should fall back to HMAC-SHA256 when Ed25519 is disabled", () => {
      const { WebhookService } = require("../../src/services/webhook");
      const service = new WebhookService({
        webhookUrl: "https://example.com/webhook",
        webhookSecret: "test-secret",
        useEd25519: false,
      });

      const signature = service.signPayload(testPayload);
      expect(signature).toMatch(/^sha256:.+$/);
    });
  });

  describe("Performance and security", () => {
    it("should sign and verify large payloads efficiently", () => {
      const largePayload = JSON.stringify({
        data: "x".repeat(10000),
        event: "transaction.completed",
      });

      const start = Date.now();
      const signature = signPayloadEd25519(largePayload, privateKeyHex);
      const isValid = verifySignatureEd25519(
        largePayload,
        signature,
        publicKeyHex,
      );
      const duration = Date.now() - start;

      expect(isValid).toBe(true);
      expect(duration).toBeLessThan(100); // Should be fast (< 100ms)
    });

    it("should produce consistent signatures (deterministic)", () => {
      const signatures = [];
      for (let i = 0; i < 10; i++) {
        signatures.push(signPayloadEd25519(testPayload, privateKeyHex));
      }
      // All signatures should be identical (Ed25519 is deterministic)
      const unique = new Set(signatures);
      expect(unique.size).toBe(1);
    });

    it("should not accept modified payloads with valid signatures", () => {
      const signature = signPayloadEd25519(testPayload, privateKeyHex);

      // Try various tampering attempts
      const tampered = [
        testPayload.replace('"amount"', '"amountx"'),
        testPayload.slice(0, -1), // Remove last char
        testPayload + " ",
        JSON.stringify(
          Object.assign(JSON.parse(testPayload), { malicious: true }),
        ),
      ];

      for (const payload of tampered) {
        const isValid = verifySignatureEd25519(payload, signature, publicKeyHex);
        expect(isValid).toBe(false);
      }
    });
  });
});
