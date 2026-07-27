import { z } from "zod";
import { twoFactorAuthService } from "../services/twoFactorAuthService";
import { AuthRequest } from "../middleware/auth";

const setup2FaSchema = z.object({
  email: z.string().email(),
});

const enable2FaSchema = z.object({
  token: z.string().length(6),
});

const verify2FaSchema = z.object({
  token: z.string().min(4),
  method: z.enum(["totp", "backup", "sms"]).optional(),
});

const trustedDeviceSchema = z.object({
  deviceName: z.string().min(1).max(120),
  userAgent: z.string().optional(),
});

export const getTwoFactorStatus = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const status = await twoFactorAuthService.getTwoFactorStatus(userId);
    res.json({ data: status });
  } catch (error) {
    console.error("Failed to get 2FA status:", error);
    res.status(500).json({ error: "Failed to get 2FA status" });
  }
};

export const setupTwoFactor = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const parsed = setup2FaSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
      return;
    }

    const secret = await twoFactorAuthService.setupTwoFactor(userId, parsed.data.email);
    res.status(201).json({
      data: {
        secret: secret.secret,
        qrCode: secret.qrCode,
        backupCodes: secret.backupCodes,
      },
    });
  } catch (error) {
    console.error("Failed to setup 2FA:", error);
    res.status(500).json({ error: "Failed to setup 2FA" });
  }
};

export const enableTwoFactor = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const parsed = enable2FaSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
      return;
    }

    const result = await twoFactorAuthService.enableTwoFactor(userId, parsed.data.token);
    if (!result) {
      res.status(400).json({ error: "Invalid token" });
      return;
    }

    res.json({ message: "Two-factor authentication enabled successfully" });
  } catch (error) {
    console.error("Failed to enable 2FA:", error);
    res.status(500).json({ error: "Failed to enable 2FA" });
  }
};

export const disableTwoFactor = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    await twoFactorAuthService.disableTwoFactor(userId);
    res.json({ message: "Two-factor authentication disabled successfully" });
  } catch (error) {
    console.error("Failed to disable 2FA:", error);
    res.status(500).json({ error: "Failed to disable 2FA" });
  }
};

export const verifyTwoFactor = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const parsed = verify2FaSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
      return;
    }

    const result = await twoFactorAuthService.verifyTwoFactor(
      userId,
      parsed.data.token,
      parsed.data.method || "totp",
    );

    if (!result.success) {
      res.status(400).json({ error: "Invalid token" });
      return;
    }

    res.json({ message: "Two-factor verification successful", method: result.method });
  } catch (error) {
    console.error("Failed to verify 2FA:", error);
    res.status(500).json({ error: "Failed to verify 2FA" });
  }
};

export const regenerateBackupCodes = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const codes = await twoFactorAuthService.regenerateBackupCodes(userId);
    res.json({ data: { backupCodes: codes } });
  } catch (error) {
    console.error("Failed to regenerate backup codes:", error);
    res.status(500).json({ error: "Failed to regenerate backup codes" });
  }
};

export const addTrustedDevice = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const parsed = trustedDeviceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
      return;
    }

    const device = await twoFactorAuthService.registerTrustedDevice(
      userId,
      parsed.data.deviceName,
      parsed.data.userAgent || req.get("user-agent") || "unknown",
      req.ip || "unknown",
    );

    res.status(201).json({ data: device });
  } catch (error) {
    console.error("Failed to add trusted device:", error);
    res.status(500).json({ error: "Failed to add trusted device" });
  }
};

export const listTrustedDevices = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const devices = await twoFactorAuthService.listTrustedDevices(userId);
    res.json({ data: devices });
  } catch (error) {
    console.error("Failed to list trusted devices:", error);
    res.status(500).json({ error: "Failed to list trusted devices" });
  }
};

export const deleteTrustedDevice = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { deviceId } = req.params;
    await twoFactorAuthService.deleteTrustedDevice(userId, deviceId);
    res.status(204).send();
  } catch (error) {
    console.error("Failed to delete trusted device:", error);
    res.status(500).json({ error: "Failed to delete trusted device" });
  }
};
