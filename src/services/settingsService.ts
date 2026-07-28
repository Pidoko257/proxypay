import { queryRead } from "../config/database";
import { AuditContext } from "../middleware/auditContext";
import {
  DEFAULT_SETTINGS,
  normaliseCurrency,
  PartialUserSettings,
  UserSettings,
  validateSettings,
  ValidationError,
} from "../utils/settingsPanel";
import { withAuditTransaction } from "./auditTransaction";

type SettingsResult =
  { settings: UserSettings } | { errors: ValidationError[] };

function mapRow(row: Record<string, any>): UserSettings {
  return {
    theme: row.theme,
    currency: row.currency,
    notifications: {
      toastDensity: row.toast_density,
      quietMode: row.quiet_mode,
    },
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function defaultSettings(): UserSettings {
  return {
    theme: DEFAULT_SETTINGS.theme,
    currency: DEFAULT_SETTINGS.currency,
    notifications: {
      ...DEFAULT_SETTINGS.notifications,
    },
    updatedAt: DEFAULT_SETTINGS.updatedAt,
  };
}

export class SettingsService {
  async get(userId: string): Promise<UserSettings> {
    const result = await queryRead(
      `SELECT theme, currency, toast_density, quiet_mode, updated_at
         FROM user_settings
        WHERE user_id = $1`,
      [userId],
    );

    return result.rows[0] ? mapRow(result.rows[0]) : defaultSettings();
  }

  async update(
    userId: string,
    patch: PartialUserSettings,
    context: AuditContext,
  ): Promise<SettingsResult> {
    const errors = validateSettings(patch);
    if (errors.length > 0) return { errors };

    return withAuditTransaction(context, async (client) => {
      const currentResult = await client.query(
        `SELECT theme, currency, toast_density, quiet_mode, updated_at
           FROM user_settings
          WHERE user_id = $1
          FOR UPDATE`,
        [userId],
      );
      const before = currentResult.rows[0]
        ? mapRow(currentResult.rows[0])
        : defaultSettings();
      const currency =
        patch.currency !== undefined
          ? (normaliseCurrency(patch.currency) ?? before.currency)
          : before.currency;
      const next: UserSettings = {
        theme: patch.theme ?? before.theme,
        currency,
        notifications: {
          toastDensity:
            patch.notifications?.toastDensity ??
            before.notifications.toastDensity,
          quietMode:
            patch.notifications?.quietMode ?? before.notifications.quietMode,
        },
        updatedAt: new Date().toISOString(),
      };

      const result = await client.query(
        `INSERT INTO user_settings
           (user_id, theme, currency, toast_density, quiet_mode, updated_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id) DO UPDATE SET
           theme = EXCLUDED.theme,
           currency = EXCLUDED.currency,
           toast_density = EXCLUDED.toast_density,
           quiet_mode = EXCLUDED.quiet_mode,
           updated_at = CURRENT_TIMESTAMP
         RETURNING theme, currency, toast_density, quiet_mode, updated_at`,
        [
          userId,
          next.theme,
          next.currency,
          next.notifications.toastDensity,
          next.notifications.quietMode,
        ],
      );
      const settings = mapRow(result.rows[0]);

      return {
        value: { settings },
        audit: {
          action: "settings.update",
          entityType: "user_settings",
          entityId: userId,
          beforeState: before,
          afterState: settings,
        },
      };
    });
  }

  async reset(userId: string, context: AuditContext): Promise<UserSettings> {
    return withAuditTransaction(context, async (client) => {
      const currentResult = await client.query(
        `SELECT theme, currency, toast_density, quiet_mode, updated_at
           FROM user_settings
          WHERE user_id = $1
          FOR UPDATE`,
        [userId],
      );
      const before = currentResult.rows[0]
        ? mapRow(currentResult.rows[0])
        : defaultSettings();
      const result = await client.query(
        `INSERT INTO user_settings
           (user_id, theme, currency, toast_density, quiet_mode, updated_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id) DO UPDATE SET
           theme = EXCLUDED.theme,
           currency = EXCLUDED.currency,
           toast_density = EXCLUDED.toast_density,
           quiet_mode = EXCLUDED.quiet_mode,
           updated_at = CURRENT_TIMESTAMP
         RETURNING theme, currency, toast_density, quiet_mode, updated_at`,
        [
          userId,
          DEFAULT_SETTINGS.theme,
          DEFAULT_SETTINGS.currency,
          DEFAULT_SETTINGS.notifications.toastDensity,
          DEFAULT_SETTINGS.notifications.quietMode,
        ],
      );
      const settings = mapRow(result.rows[0]);

      return {
        value: settings,
        audit: {
          action: "settings.reset",
          entityType: "user_settings",
          entityId: userId,
          beforeState: before,
          afterState: settings,
        },
      };
    });
  }
}

export const settingsService = new SettingsService();
