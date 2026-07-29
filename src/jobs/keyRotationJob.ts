import { pool } from "../config/database";
import { encryptField, decryptField } from "../utils/encryption";
import logger from "../utils/logger";

const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 100;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Non-blocking PII encryption key rotation background job.
 * Processes encrypted PII fields in batches, re-encrypting with the active key version
 * while keeping old keys readable via dual-key fallback support.
 */
export async function runKeyRotationJob(): Promise<void> {
  const activeVersion = process.env.ACTIVE_ENCRYPTION_KEY_VERSION || "v1";
  logger.info({ activeVersion }, "[KeyRotation] Starting PII key rotation job");

  let totalProcessed = 0;
  let totalReencrypted = 0;

  try {
    // 1. Rotate Users table PII (e.g. phone_number, email)
    let offset = 0;
    while (true) {
      const { rows } = await pool.query(
        `SELECT id, phone_number, email FROM users ORDER BY id LIMIT $1 OFFSET $2`,
        [BATCH_SIZE, offset],
      );

      if (rows.length === 0) break;

      for (const row of rows) {
        totalProcessed++;
        let updated = false;

        let newPhone = row.phone_number;
        if (row.phone_number) {
          const decrypted = decryptField(row.phone_number);
          if (decrypted) {
            const reencrypted = encryptField(decrypted);
            if (reencrypted !== row.phone_number) {
              newPhone = reencrypted;
              updated = true;
            }
          }
        }

        let newEmail = row.email;
        if (row.email) {
          const decrypted = decryptField(row.email);
          if (decrypted) {
            const reencrypted = encryptField(decrypted);
            if (reencrypted !== row.email) {
              newEmail = reencrypted;
              updated = true;
            }
          }
        }

        if (updated) {
          await pool.query(
            `UPDATE users SET phone_number = $1, email = $2 WHERE id = $3`,
            [newPhone, newEmail, row.id],
          );
          totalReencrypted++;
        }
      }

      offset += BATCH_SIZE;
      await delay(BATCH_DELAY_MS); // Non-blocking yield to allow other DB operations
    }

    logger.info(
      { totalProcessed, totalReencrypted, activeVersion },
      "[KeyRotation] PII key rotation job completed successfully",
    );
  } catch (error) {
    logger.error(
      { error, totalProcessed, totalReencrypted },
      "[KeyRotation] Error during PII key rotation job execution",
    );
    throw error;
  }
}
