import {
  generateTOTPSecret,
  verifyTOTPToken,
  hashBackupCodes,
  verifyBackupCode,
  validateTOTPSetup,
} from "../auth/2fa";
import { getUserById, update2FAFields } from "./userService";

export interface SetupResult {
  otpauthUri: string;
  backupCodes: string[];
}

/**
 * Generate a new TOTP secret for the user and persist it (unverified).
 * Returns the otpauth:// URI and plain-text backup codes to show the user once.
 */
export async function setupTOTP(userId: string): Promise<SetupResult> {
  const user = await getUserById(userId);
  if (!user) throw new Error("User not found");

  const { secret, qrCode, backupCodes } = generateTOTPSecret(user.phone_number);
  const hashedBackupCodes = await hashBackupCodes(backupCodes);

  await update2FAFields(userId, {
    two_factor_secret: secret,
    two_factor_enabled: false,
    two_factor_verified: false,
    backup_codes: hashedBackupCodes,
  });

  return { otpauthUri: qrCode, backupCodes };
}

/**
 * Confirm setup by validating the user's first TOTP token.
 * Marks two_factor_enabled and two_factor_verified true on success.
 */
export async function verifyTOTPSetup(userId: string, token: string): Promise<void> {
  const user = await getUserById(userId);
  if (!user?.two_factor_secret) throw new Error("2FA setup not initiated");

  if (!validateTOTPSetup(user.two_factor_secret, token)) {
    throw new Error("Invalid TOTP token");
  }

  await update2FAFields(userId, {
    two_factor_enabled: true,
    two_factor_verified: true,
  });
}

export interface VerifyResult {
  userId: string;
  usedBackupCode: boolean;
  backupCodeId?: string;
}

/**
 * Verify a TOTP code or backup code during login.
 * Returns the user ID on success so the caller can issue a full JWT.
 */
export async function verifyTOTPLogin(
  userId: string,
  code: string,
): Promise<VerifyResult> {
  const user = await getUserById(userId);
  if (!user) throw new Error("User not found");
  if (!user.two_factor_secret || !user.two_factor_enabled || !user.two_factor_verified) {
    throw new Error("2FA not enabled for this user");
  }

  // Try TOTP first
  if (verifyTOTPToken(user.two_factor_secret, code)) {
    return { userId, usedBackupCode: false };
  }

  // Try backup codes
  const rawBackupCodes = user.backup_codes ?? [];
  const backupCodeObjects = rawBackupCodes.map((hash, i) => ({
    id: String(i),
    code_hash: hash,
    used: false,
    created_at: new Date(),
  }));

  const { valid, codeId } = await verifyBackupCode(code, backupCodeObjects);
  if (!valid) throw new Error("Invalid 2FA code");

  // Mark the backup code used by removing it from the array
  if (codeId !== undefined) {
    const updatedCodes = rawBackupCodes.filter((_, i) => String(i) !== codeId);
    await update2FAFields(userId, { backup_codes: updatedCodes });
  }

  return { userId, usedBackupCode: true, backupCodeId: codeId };
}
