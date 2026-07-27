import { Request, Response } from "express";
import { z } from "zod";
import { assetCustomizationService } from "../services/assetCustomizationService";
import { AuthRequest } from "../middleware/auth";

const createAssetPreferenceSchema = z.object({
  assetCode: z.string().min(1, "assetCode is required").max(12),
  issuerPublicKey: z.string().min(56).max(56),
  isPreferred: z.boolean().optional(),
  isActiveForSettlement: z.boolean().optional(),
  dailyLimitXaf: z.number().positive().optional(),
  minAmountXaf: z.number().positive().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const listUserAssetPreferences = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const preferences = await assetCustomizationService.listUserPreferences(userId);
    res.json({ data: preferences });
  } catch (error) {
    console.error("Failed to list asset preferences:", error);
    res.status(500).json({ error: "Failed to list asset preferences" });
  }
};

export const getUserPreferredAsset = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const preference = await assetCustomizationService.getUserPreferredAsset(userId);
    res.json({ data: preference });
  } catch (error) {
    console.error("Failed to get preferred asset:", error);
    res.status(500).json({ error: "Failed to get preferred asset" });
  }
};

export const createAssetPreference = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const parsed = createAssetPreferenceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid input",
        details: parsed.error.issues,
      });
      return;
    }

    const preference = await assetCustomizationService.upsertPreference(userId, parsed.data);
    res.status(201).json({ data: preference });
  } catch (error) {
    console.error("Failed to create asset preference:", error);
    res.status(500).json({ error: "Failed to create asset preference" });
  }
};

export const setPreferredAsset = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { preferenceId } = req.params;
    const preference = await assetCustomizationService.setPreferredAsset(userId, preferenceId);
    res.json({ data: preference });
  } catch (error) {
    console.error("Failed to set preferred asset:", error);
    res.status(500).json({ error: "Failed to set preferred asset" });
  }
};

export const deleteAssetPreference = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { preferenceId } = req.params;
    await assetCustomizationService.deletePreference(userId, preferenceId);
    res.status(204).send();
  } catch (error) {
    console.error("Failed to delete asset preference:", error);
    res.status(500).json({ error: "Failed to delete asset preference" });
  }
};

export const listAvailableAssets = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  try {
    const assets = await assetCustomizationService.getAvailableAssets();
    res.json({ data: assets });
  } catch (error) {
    console.error("Failed to list available assets:", error);
    res.status(500).json({ error: "Failed to list available assets" });
  }
};

export const getUserSettlementAsset = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const asset = await assetCustomizationService.getUserSettlementAsset(userId);
    res.json({ data: asset });
  } catch (error) {
    console.error("Failed to get user settlement asset:", error);
    res.status(500).json({ error: "Failed to get user settlement asset" });
  }
};
