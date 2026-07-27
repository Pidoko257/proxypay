import crypto from "crypto";
import { pool } from "../config/database";
import { queryRead, queryWrite } from "../config/database";
import { generateTOTPSecret, generateQRCodeDataURL, verifyTOTPToken, generateBackupCodes, hashBackupCodes, verifyBackupCode, is2FAEnabled } from "../auth/2fa";
import { SmsService } from "./sms";

export interface TwoFactorMethod {
  type: "totp" | "sms";
  enabled: boolean;
  verified: boolean;
}

export interface TrustedDevice {
  id: string;
  userId: string;
  deviceName: string;
  userAgent: string;
  ipAddress: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface SetupSecret {
  secret: string;
  qrCode: string;
  backupCodes: string[];
}

export class TwoFactorAuthService {
  private smsService: SmsService;

  constructor() {
    this.smsService = new SmsService();
  }

  async setupTwoFactor(userId: string, userEmail: string): Promise<SetupSecret> {
    const secretData = generateTOTPSecret(userEmail);
    const qrCodeDataUrl = await generateQRCodeDataURL(secretData.qrCode);

    const hashedCodes = await hashBackupCodes(secretData.backupCodes);
    const backupCodesJson = hashedCodes.map((hash) => ({
      code_hash: hash,
      used: false,
      created_at: new Date(),
    }));

    await queryWrite(
      `UPDATE users
       SET two_factor_secret = $1,
           backup_codes = $2,
           two_factor_enabled = false,
           two_factor_verified = false,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [secretData.secret, JSON.stringify(backupCodesJson), userId],
    );

    return {
      secret: secretData.secret,
      qrCode: qrCodeDataUrl,
      backupCodes: secretData.backupCodes,
    };
  }

  async enableTwoFactor(userId: string, token: string): Promise<boolean> {
    const user = await this.getUserWith2FA(userId);
    if (!user || !user.two_factor_secret) {
      throw new Error("2FA not set up");
    }

    const verified = verifyTOTPToken(user.two_factor_secret, token);
    if (!verified) {
      return false;
    }

    await queryWrite(
      `UPDATE users
       SET two_factor_enabled = true,
           two_factor_verified = true,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [userId],
    );

    return true;
  }

  async disableTwoFactor(userId: string): Promise<void> {
    await queryWrite(
      `UPDATE users
       SET two_factor_secret = NULL,
           backup_codes = NULL,
           two_factor_enabled = false,
           two_factor_verified = false,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [userId],
    );

    await queryWrite("DELETE FROM trusted_devices WHERE user_id = $1", [userId]);
  }

  async verifyTwoFactor(userId: string, token: string, method: string = "totp"): Promise<{ success: boolean; method: string }> {
    const user = await this.getUserWith2FA(userId);
    if (!user || !is2FAEnabled(user)) {
      return { success: false, method };
    }

    if (method === "totp" && user.two_factor_secret) {
      const isValid = verifyTOTPToken(user.two_factor_secret, token);
      if (isValid) {
        return { success: true, method: "totp" };
      }
    }

    if (method === "backup" || method === "sms") {
      const backupCodes = user.backup_codes || [];
      const normalizedCodes = backupCodes.map((item, index) =>
        typeof item === "string"
          ? { id: String(index), code_hash: item, used: false, created_at: new Date() }
          : item,
      );

      const verification = await verifyBackupCode(token, normalizedCodes);
      if (verification.valid && verification.codeId) {
        await queryWrite(
          "UPDATE users SET backup_codes = jsonb_set(backup_codes, $1, 'true'::jsonb) WHERE id = $2",
          [`{${verification.codeId},used}`, userId],
        );
        return { success: true, method: "backup" };
      }
    }

    return { success: false, method };
  }

  async regenerateBackupCodes(userId: string): Promise<string[]> {
    const user = await this.getUserWith2FA(userId);
    if (!user || !user.two_factor_secret) {
      throw new Error("2FA must be enabled before regenerating backup codes");
    }

    const newCodes = generateBackupCodes();
    const hashedCodes = await hashBackupCodes(newCodes);
    const backupCodesJson = hashedCodes.map((hash) => ({
      code_hash: hash,
      used: false,
      created_at: new Date(),
    }));

    await queryWrite(
      `UPDATE users
       SET backup_codes = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [JSON.stringify(backupCodesJson), userId],
    );

    return newCodes;
  }

  async getTwoFactorStatus(userId: string): Promise<{ enabled: boolean; methods: TwoFactorMethod[] }> {
    const user = await this.getUserWith2FA(userId);
    if (!user) {
      return { enabled: false, methods: [] };
    }

    const enabled = is2FAEnabled(user);
    return {
      enabled,
      methods: [
        { type: "totp", enabled, verified: enabled },
        { type: "sms", enabled, verified: false },
      ],
    };
  }

  async registerTrustedDevice(
    userId: string,
    deviceName: string,
    userAgent: string,
    ipAddress: string,
  ): Promise<TrustedDevice> {
    const deviceId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const query = `
      INSERT INTO trusted_devices (id, user_id, device_name, user_agent, ip_address, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, user_id AS "userId", device_name AS "deviceName", user_agent AS "userAgent",
                ip_address AS "ipAddress", created_at AS "createdAt", expires_at AS "expiresAt"
    `;

    const result = await queryRead(query, [deviceId, userId, deviceName, userAgent, ipAddress, expiresAt]);
    return this.mapTrustedDeviceRow(result.rows[0]);
  }

  async listTrustedDevices(userId: string): Promise<TrustedDevice[]> {
    const query = `
      SELECT id, user_id AS "userId", device_name AS "deviceName", user_agent AS "userAgent",
             ip_address AS "ipAddress", created_at AS "createdAt", expires_at AS "expiresAt"
      FROM trusted_devices
      WHERE user_id = $1
      ORDER BY created_at DESC
    `;

    const result = await queryRead(query, [userId]);
    return result.rows.map(this.mapTrustedDeviceRow);
  }

  async deleteTrustedDevice(userId: string, deviceId: string): Promise<void> {
    await queryWrite("DELETE FROM trusted_devices WHERE id = $1 AND user_id = $2", [deviceId, userId]);
  }

  async isDeviceTrusted(userId: string, deviceId: string): Promise<boolean> {
    const query = `
      SELECT 1 FROM trusted_devices
      WHERE user_id = $1 AND id = $2 AND expires_at > NOW()
    `;
    const result = await queryRead(query, [userId, deviceId]);
    return result.rows.length > 0;
  }

  async sendSmsTwoFactor(userId: string, phoneNumber: string): Promise<{ sent: boolean; skippedReason?: string }> {
    const user = await this.getUserWith2FA(userId);
    if (!user || !is2FAEnabled(user)) {
      return { sent: false, skippedReason: "2fa_not_enabled" };
    }

    const otp = crypto.randomInt(100000, 999999).toString();

    try {
      if (pool && pool.isConnected) {
        await queryWrite(
          "INSERT INTO two_factor_otps (user_id, code, channel, expires_at) VALUES ($1, $2, $3, $4)",
          [userId, otp, "sms", new Date(Date.now() + 5 * 60 * 1000)],
        );
      }
    } catch {
      // table may not exist yet; fallback to redis
    }

    try {
      const result = await this.smsService.sendToPhone(phoneNumber, `Your verification code is: ${otp}`);
      return { sent: result.sent, skippedReason: result.skippedReason };
    } catch {
      return { sent: false };
    }
  }

  private async getUserWith2FA(userId: string): Promise<{
    id: string;
    two_factor_secret: string | null;
    backup_codes: unknown[];
    two_factor_enabled: boolean;
    two_factor_verified: boolean;
  } | null> {
    const query = `
      SELECT id, two_factor_secret, backup_codes, two_factor_enabled, two_factor_verified
      FROM users
      WHERE id = $1
    `;
    const result = await queryRead(query, [userId]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      two_factor_secret: row.two_factor_secret,
      backup_codes: row.backup_codes || [],
      two_factor_enabled: row.two_factor_enabled,
      two_factor_verified: row.two_factor_verified,
    };
  }

  private mapTrustedDeviceRow(row: Record<string, unknown>): TrustedDevice {
    return {
      id: row.id as string,
      userId: row.userId as string,
      deviceName: row.deviceName as string,
      userAgent: row.userAgent as string,
      ipAddress: row.ipAddress as string,
      createdAt: new Date(row.createdAt as Date),
      expiresAt: new Date(row.expiresAt as Date),
    };
  }
}

export const twoFactorAuthService = new TwoFactorAuthService();
