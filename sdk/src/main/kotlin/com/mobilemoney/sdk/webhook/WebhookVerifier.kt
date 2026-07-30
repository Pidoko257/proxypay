package com.mobilemoney.sdk.webhook

import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.*
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Webhook Signature Verification Helper
 *
 * Verifies webhook signatures from ProxyPay using either Ed25519 or HMAC-SHA256.
 *
 * Usage:
 * ```kotlin
 * val verifier = WebhookVerifier()
 * val isValid = verifier.verifySignature(
 *   payload = requestBody,
 *   signatureHeader = request.getHeader("X-Webhook-Signature"),
 *   secret = "your-public-key-or-hmac-secret"
 * )
 * ```
 */
class WebhookVerifier {

  /**
   * Verify webhook signature — supports both Ed25519 and HMAC-SHA256.
   *
   * @param payload The raw request body (String or ByteArray)
   * @param signatureHeader The value of X-Webhook-Signature header
   * @param secret For HMAC: the webhook secret. For Ed25519: the public key (hex-encoded).
   * @return true if signature is valid, false otherwise
   */
  fun verifySignature(
    payload: Any,
    signatureHeader: String,
    secret: String
  ): Boolean {
    return try {
      val payloadBytes = when (payload) {
        is String -> payload.toByteArray(Charsets.UTF_8)
        is ByteArray -> payload
        else -> return false
      }

      when {
        signatureHeader.startsWith("ed25519:") -> {
          val signature = signatureHeader.substring(8) // Remove "ed25519:" prefix
          verifyEd25519Signature(payloadBytes, signature, secret)
        }
        signatureHeader.startsWith("sha256=") -> {
          val signature = signatureHeader.substring(7) // Remove "sha256=" prefix
          verifyHmacSha256Signature(payloadBytes, signature, secret)
        }
        else -> false
      }
    } catch (e: Exception) {
      false // Verification errors return false
    }
  }

  /**
   * Verify Ed25519 signature
   *
   * @param payload The payload bytes
   * @param signatureBase64 Base64-encoded signature
   * @param publicKeyHex The Ed25519 public key in hex format (32 bytes)
   * @return true if signature is valid
   */
  private fun verifyEd25519Signature(
    payload: ByteArray,
    signatureBase64: String,
    publicKeyHex: String
  ): Boolean {
    try {
      val signatureBytes = Base64.getDecoder().decode(signatureBase64)

      // Verify signature length (Ed25519 signatures are always 64 bytes)
      if (signatureBytes.size != 64) {
        return false
      }

      // Decode the public key from hex
      val publicKeyBytes = hexStringToByteArray(publicKeyHex)
      if (publicKeyBytes.size != 32) {
        return false
      }

      // Create EdDSA public key using X.509 encoding
      // Note: Java's built-in Ed25519 support requires the key in PKIX format
      val keySpec = X509EncodedKeySpec(publicKeyBytes)
      val keyFactory = KeyFactory.getInstance("EdDSA")
      val publicKey = keyFactory.generatePublic(keySpec)

      // Verify the signature
      val sig = Signature.getInstance("EdDSA")
      sig.initVerify(publicKey)
      sig.update(payload)
      return sig.verify(signatureBytes)
    } catch (e: Exception) {
      return false
    }
  }

  /**
   * Verify HMAC-SHA256 signature (for backward compatibility)
   *
   * @param payload The payload bytes
   * @param signatureHex The hex-encoded signature
   * @param secret The webhook secret
   * @return true if signature is valid
   */
  private fun verifyHmacSha256Signature(
    payload: ByteArray,
    signatureHex: String,
    secret: String
  ): Boolean {
    try {
      val mac = Mac.getInstance("HmacSHA256")
      val secretKeySpec = SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256")
      mac.init(secretKeySpec)
      val expectedSignature = mac.doFinal(payload).toHexString()

      // Constant-time comparison to prevent timing attacks
      if (signatureHex.length != expectedSignature.length) {
        return false
      }

      return timingSafeEqual(signatureHex, expectedSignature)
    } catch (e: Exception) {
      return false
    }
  }

  /**
   * Constant-time string comparison to prevent timing attacks
   */
  private fun timingSafeEqual(a: String, b: String): Boolean {
    var result = 0
    for (i in 0 until minOf(a.length, b.length)) {
      result = result or (a[i].code xor b[i].code)
    }
    result = result or (a.length xor b.length)
    return result == 0
  }

  /**
   * Convert ByteArray to hex string
   */
  private fun ByteArray.toHexString(): String =
    joinToString("") { "%02x".format(it) }

  /**
   * Convert hex string to ByteArray
   */
  private fun hexStringToByteArray(s: String): ByteArray {
    val len = s.length
    val data = ByteArray(len / 2)
    for (i in 0 until len step 2) {
      data[i / 2] = ((s[i].digitToInt(16) shl 4) + s[i + 1].digitToInt(16)).toByte()
    }
    return data
  }
}

/**
 * Convenience function to verify webhook signatures.
 * Create a shared instance or use directly.
 */
fun verifyWebhookSignature(
  payload: Any,
  signatureHeader: String,
  secret: String
): Boolean = WebhookVerifier().verifySignature(payload, signatureHeader, secret)
