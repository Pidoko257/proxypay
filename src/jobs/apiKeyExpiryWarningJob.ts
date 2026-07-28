import { queryRead } from "../config/database";
import { decrypt } from "../utils/encryption";
import { emailService } from "../services/email";

const WARNING_WINDOW_DAYS = 14;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

interface ExpiringApiKeyRow {
  id: string;
  key_prefix: string;
  label: string | null;
  expires_at: Date;
  email: string | null;
}

export async function runApiKeyExpiryWarningJob(): Promise<void> {
  const result = await queryRead<ExpiringApiKeyRow>(
    `SELECT api_keys.id,
            LEFT(api_keys.key, 8) AS key_prefix,
            api_keys.label,
            api_keys.expires_at,
            users.email
       FROM api_keys
       JOIN users ON users.id = api_keys.user_id
      WHERE api_keys.is_active = TRUE
        AND api_keys.expires_at > NOW()
        AND api_keys.expires_at <= NOW() + INTERVAL '14 days'
        AND users.email IS NOT NULL`,
  );

  const now = Date.now();
  for (const row of result.rows) {
    const email = decrypt(row.email);
    if (!email) continue;

    const expiresAt = new Date(row.expires_at);
    const daysRemaining = Math.max(
      1,
      Math.ceil((expiresAt.getTime() - now) / MILLISECONDS_PER_DAY),
    );

    await emailService.sendApiKeyExpiryWarning(email, {
      keyId: row.id,
      keyPrefix: row.key_prefix,
      label: row.label,
      expiresAt,
      daysRemaining: Math.min(WARNING_WINDOW_DAYS, daysRemaining),
    });
  }
}
