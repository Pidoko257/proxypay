/**
 * Settings Panel — REST API
 *
 * Endpoints:
 *   GET    /api/settings          — Retrieve current user's settings
 *   PATCH  /api/settings          — Partial update (theme, currency, notifications)
 *   DELETE /api/settings          — Reset to defaults
 *   GET    /api/settings/options  — Enumerate valid option values for the UI
 *
 * Authentication: all routes require a valid JWT (requireAuth middleware).
 * The userId is read from req.user.id (populated by the auth middleware).
 *
 * Accessibility / WCAG AA:
 *   - Validation errors are returned as structured JSON arrays so assistive
 *     technologies can surface them field-by-field.
 *   - The "system" theme value signals the client to honour
 *     prefers-color-scheme, ensuring WCAG AA contrast compliance without
 *     hard-coding a colour scheme.
 *   - The "compact" toastDensity maps to prefers-reduced-motion on the client,
 *     reducing animation for users who need it.
 */

import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import {
  getSettings,
  updateSettings,
  resetSettings,
  SETTINGS_OPTIONS,
  PartialUserSettings,
} from "../utils/settingsPanel";

const router = Router();

// All settings routes require authentication.
router.use(requireAuth);

// ---------------------------------------------------------------------------
// GET /api/settings
// ---------------------------------------------------------------------------
router.get("/", (req: Request, res: Response): void => {
  const userId = (req as Request & { user?: { id: string } }).user?.id;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const settings = getSettings(userId);
  res.json({ settings });
});

// ---------------------------------------------------------------------------
// PATCH /api/settings
// ---------------------------------------------------------------------------
router.patch("/", (req: Request, res: Response): void => {
  const userId = (req as Request & { user?: { id: string } }).user?.id;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const patch = req.body as PartialUserSettings;
  const result = updateSettings(userId, patch);

  if ("errors" in result) {
    // Return structured validation errors — screen-reader friendly.
    res.status(422).json({
      error: "Validation failed",
      details: result.errors,
    });
    return;
  }

  res.json({ settings: result.settings });
});

// ---------------------------------------------------------------------------
// DELETE /api/settings  (reset to defaults)
// ---------------------------------------------------------------------------
router.delete("/", (req: Request, res: Response): void => {
  const userId = (req as Request & { user?: { id: string } }).user?.id;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const settings = resetSettings(userId);
  res.json({ settings });
});

// ---------------------------------------------------------------------------
// GET /api/settings/options
// ---------------------------------------------------------------------------
router.get("/options", (_req: Request, res: Response): void => {
  res.json({ options: SETTINGS_OPTIONS });
});

export default router;
