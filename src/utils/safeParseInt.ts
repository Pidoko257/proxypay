import logger from "./logger";

export interface ParseNumberOptions {
  min?: number;
  max?: number;
  varName?: string;
  strict?: boolean;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/**
 * Safely parse an integer from an environment variable or string, ensuring
 * it is a valid integer within the designated [min, max] range.
 *
 * Prevents silent fallback or NaN poisoning in pools, retries, fraud thresholds,
 * timeouts, and external client limits.
 */
export function safeParseInt(
  value: string | undefined | null,
  defaultValue: number,
  options: ParseNumberOptions = {}
): number {
  if (value === undefined || value === null || value.trim() === "") {
    return defaultValue;
  }

  const trimmed = value.trim();
  // Ensure the string contains only an integer format
  if (!/^-?\d+$/.test(trimmed)) {
    const msg = `Invalid integer for ${options.varName || "runtime option"}: '${value}'. Expected valid integer, defaulting to ${defaultValue}.`;
    if (options.strict) {
      throw new ConfigurationError(msg);
    }
    logger.warn(`[Config] ${msg}`);
    return defaultValue;
  }

  const parsed = parseInt(trimmed, 10);
  if (Number.isNaN(parsed)) {
    const msg = `Failed to parse integer for ${options.varName || "runtime option"}: '${value}', defaulting to ${defaultValue}.`;
    if (options.strict) {
      throw new ConfigurationError(msg);
    }
    logger.warn(`[Config] ${msg}`);
    return defaultValue;
  }

  if (options.min !== undefined && parsed < options.min) {
    const msg = `Value ${parsed} for ${options.varName || "runtime option"} is below minimum allowed ${options.min}. Clamping to minimum.`;
    if (options.strict) {
      throw new ConfigurationError(msg);
    }
    logger.warn(`[Config] ${msg}`);
    return options.min;
  }

  if (options.max !== undefined && parsed > options.max) {
    const msg = `Value ${parsed} for ${options.varName || "runtime option"} exceeds maximum allowed ${options.max}. Clamping to maximum.`;
    if (options.strict) {
      throw new ConfigurationError(msg);
    }
    logger.warn(`[Config] ${msg}`);
    return options.max;
  }

  return parsed;
}

/**
 * Safely parse a floating-point number with range bounds and NaN prevention.
 */
export function safeParseFloat(
  value: string | undefined | null,
  defaultValue: number,
  options: ParseNumberOptions = {}
): number {
  if (value === undefined || value === null || value.trim() === "") {
    return defaultValue;
  }

  const parsed = parseFloat(value.trim());
  if (Number.isNaN(parsed) || !Number.isFinite(parsed)) {
    const msg = `Invalid float for ${options.varName || "runtime option"}: '${value}', defaulting to ${defaultValue}.`;
    if (options.strict) {
      throw new ConfigurationError(msg);
    }
    logger.warn(`[Config] ${msg}`);
    return defaultValue;
  }

  if (options.min !== undefined && parsed < options.min) {
    return options.min;
  }

  if (options.max !== undefined && parsed > options.max) {
    return options.max;
  }

  return parsed;
}

/**
 * Safely parse duration in milliseconds from string representations like '30s', '5m', '1h' or raw ms.
 */
export function safeParseDurationMs(
  value: string | undefined | null,
  defaultValueMs: number
): number {
  if (!value || value.trim() === "") return defaultValueMs;

  const trimmed = value.trim();
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(trimmed);
  if (!match) {
    logger.warn(`[Config] Invalid duration string '${value}', defaulting to ${defaultValueMs}ms`);
    return defaultValueMs;
  }

  const amount = parseFloat(match[1]);
  const unit = (match[2] || "ms").toLowerCase();

  switch (unit) {
    case "s":
      return Math.round(amount * 1000);
    case "m":
      return Math.round(amount * 60 * 1000);
    case "h":
      return Math.round(amount * 60 * 60 * 1000);
    case "d":
      return Math.round(amount * 24 * 60 * 60 * 1000);
    case "ms":
    default:
      return Math.round(amount);
  }
}
