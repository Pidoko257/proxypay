import dotenv from "dotenv";
import fs from "fs";
import path from "path";

// Load .momorc from the cli/ directory, fall back to process.env
const MOMORC_PATH = path.resolve(__dirname, "..", ".momorc");
dotenv.config({ path: MOMORC_PATH });

export interface CliConfig {
  apiUrl: string;
  apiKey: string;
  telemetry: boolean;
}

export function getConfig(): CliConfig {
  const apiKey = process.env.MOMO_API_KEY;
  if (!apiKey) {
    throw new Error(
      "MOMO_API_KEY is required. Set it in cli/.momorc or as an environment variable.",
    );
  }
  return {
    apiUrl: process.env.MOMO_API_URL ?? "http://localhost:3000",
    apiKey,
    telemetry: getTelemetryEnabled(),
  };
}

/**
 * Returns whether anonymous telemetry collection is enabled.
 * Defaults to true if not explicitly set to "false".
 */
export function getTelemetryEnabled(): boolean {
  return process.env.MOMO_TELEMETRY !== "false";
}

/**
 * Persists the telemetry setting to the .momorc config file.
 * Reads existing key=value lines and upserts MOMO_TELEMETRY.
 */
export function setTelemetryEnabled(enabled: boolean): void {
  const value = enabled ? "true" : "false";

  let lines: string[] = [];

  // Read existing .momorc if it exists
  if (fs.existsSync(MOMORC_PATH)) {
    lines = fs.readFileSync(MOMORC_PATH, "utf-8").split("\n");
  }

  const key = "MOMO_TELEMETRY";
  const entry = `${key}=${value}`;
  const idx = lines.findIndex((l) => l.trimStart().startsWith(`${key}=`));

  if (idx !== -1) {
    lines[idx] = entry;
  } else {
    lines.push(entry);
  }

  const content =
    lines
      .filter((l, i) => l.trim() !== "" || i < lines.length - 1)
      .join("\n")
      .trimEnd() + "\n";
  fs.writeFileSync(MOMORC_PATH, content, "utf-8");

  // Keep the current process in sync without a restart
  process.env[key] = value;
}
