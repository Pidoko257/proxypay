/**
 * Ed25519 Webhook Signature Utilities
 *
 * Provides functions for signing and verifying webhook payloads using Ed25519.
 * Ed25519 offers:
 * - Better security properties than RSA
 * - Faster signature generation and verification
 * - Smaller key sizes (32 bytes)
 * - Deterministic signatures (no randomness needed)
 *
 * Key Format:
 * - Private key: 32 bytes (raw) or hex-encoded string
 * - Public key: 32 bytes (raw) or hex-encoded string
 * - Signature: 64 bytes (raw) or base64-encoded string
 */

import { createPrivateKey, createPublicKey, sign, verify, generateKeyPairSync } from "crypto";

/**
 * Generate a new Ed25519 keypair.
 * @returns Object with private and public keys in hex format
 */
export function generateEd25519Keypair(): {
  privateKeyHex: string;
  publicKeyHex: string;
} {
  try {
    const { privateKey: privKey, publicKey: pubKey } = generateKeyPairSync("ed25519", {});

    // Export as DER/PKCS8 and raw
    const privDer = privKey.export({ format: "pkcs8", type: "pkcs8" });
    const pubRaw = pubKey.export({ format: "raw", type: "spki" });

    // For Ed25519, the private key in PKCS8 format has a specific structure
    // Extract the 32-byte seed from PKCS8 (starts at byte 16 after the header)
    const privHex = privDer.subarray(16, 48).toString("hex");
    const pubHex = pubRaw.toString("hex");

    return {
      privateKeyHex: privHex,
      publicKeyHex: pubHex,
    };
  } catch (err) {
    throw new Error(`Failed to generate Ed25519 keypair: ${err}`);
  }
}

/**
 * Sign a payload using an Ed25519 private key.
 * @param payload - The payload to sign (string or Buffer)
 * @param privateKeyHex - The Ed25519 private key in hex format (32 bytes)
 * @returns Base64-encoded signature
 */
export function signPayloadEd25519(
  payload: string | Buffer,
  privateKeyHex: string,
): string {
  try {
    const payloadBuffer = typeof payload === "string" ? Buffer.from(payload) : payload;
    const privateKeyBuffer = Buffer.from(privateKeyHex, "hex");

    // Reconstruct PKCS8 format from raw 32-byte seed
    // Ed25519 PKCS8 structure: version (1 byte) + algorithm (15 bytes) + seed (32 bytes)
    const pkcs8 = Buffer.concat([
      Buffer.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]),
      privateKeyBuffer,
    ]);

    const privateKey = createPrivateKey({
      key: pkcs8,
      format: "der",
      type: "pkcs8",
    });

    const signature = sign(null, payloadBuffer, privateKey);
    return signature.toString("base64");
  } catch (err) {
    throw new Error(`Failed to sign payload with Ed25519: ${err}`);
  }
}

/**
 * Verify an Ed25519 signature.
 * @param payload - The original payload (string or Buffer)
 * @param signatureBase64 - The signature in base64 format
 * @param publicKeyHex - The Ed25519 public key in hex format (32 bytes)
 * @returns true if signature is valid, false otherwise
 */
export function verifySignatureEd25519(
  payload: string | Buffer,
  signatureBase64: string,
  publicKeyHex: string,
): boolean {
  try {
    const payloadBuffer = typeof payload === "string" ? Buffer.from(payload) : payload;
    const signatureBuffer = Buffer.from(signatureBase64, "base64");
    const publicKeyBuffer = Buffer.from(publicKeyHex, "hex");

    // Verify signature length (Ed25519 signatures are always 64 bytes)
    if (signatureBuffer.length !== 64) {
      return false;
    }

    // Reconstruct SubjectPublicKeyInfo (SPKI) format from raw 32-byte key
    // Ed25519 SPKI structure: (12-byte header) + key (32 bytes)
    const spki = Buffer.concat([
      Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]),
      publicKeyBuffer,
    ]);

    const publicKey = createPublicKey({
      key: spki,
      format: "der",
      type: "spki",
    });

    return verify(null, payloadBuffer, publicKey, signatureBuffer);
  } catch (err) {
    // Verification errors return false rather than throwing
    return false;
  }
}

/**
 * Extract the public key from a private key (in hex format).
 * @param privateKeyHex - The Ed25519 private key in hex format (32 bytes)
 * @returns The public key in hex format (32 bytes)
 */
export function getPublicKeyFromPrivateEd25519(privateKeyHex: string): string {
  try {
    const privateKeyBuffer = Buffer.from(privateKeyHex, "hex");

    // Reconstruct PKCS8 format from raw 32-byte seed
    const pkcs8 = Buffer.concat([
      Buffer.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]),
      privateKeyBuffer,
    ]);

    const privateKey = createPrivateKey({
      key: pkcs8,
      format: "der",
      type: "pkcs8",
    });

    const publicKey = createPublicKey(privateKey);
    // Export and extract the raw 32-byte public key from SPKI
    const spki = publicKey.export({ format: "der", type: "spki" });
    return spki.subarray(12).toString("hex");
  } catch (err) {
    throw new Error(`Failed to extract public key: ${err}`);
  }
}
