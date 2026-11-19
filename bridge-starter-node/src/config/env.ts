import dotenv from "dotenv";

dotenv.config();

interface StellarConfig {
  network: "testnet" | "public" | "futurenet";
  horizonUrl: string;
  networkPassphrase: string;
  assetCode: string;
  assetIssuer: string;
}

interface SorobanConfig {
  rpcUrl: string;
  contractId: string;
  maxFeeStroops: number;
  maxInstructions: number;
  maxCpuInsns: number;
  maxMemoryBytes: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}

interface I18nConfig {
  /** Locales that must have complete translations before deploy. */
  requiredLocales: string[];
  /** Default/fallback locale used by i18next. */
  fallbackLocale: string;
  /**
   * Translation keys that must exist in every required locale. These cover
   * critical payment/compliance messages that must never fall back at runtime.
   */
  requiredKeys: string[];
  /** Emit an alert when i18next falls back for a critical key. */
  alertOnCriticalFallback: boolean;
}

interface ReportingConfig {
  /**
   * IANA timezone used to derive statement/tax report date boundaries when a
   * merchant/provider does not override it. Report windows are computed in
   * this zone and converted to half-open UTC intervals.
   */
  defaultTimezone: string;
}

interface Config {
  port: number;
  bridgeApiUrl: string;
  bridgeApiKey: string;
  webhookSecret: string;
  stellar: StellarConfig;
  soroban: SorobanConfig;
  i18n: I18nConfig;
  reporting: ReportingConfig;
}

const STELLAR_NETWORKS: Record<
  StellarConfig["network"],
  { horizonUrl: string; networkPassphrase: string }
> = {
  testnet: {
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  },
  public: {
    horizonUrl: "https://horizon.stellar.org",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
  },
  futurenet: {
    horizonUrl: "https://horizon-futurenet.stellar.org",
    networkPassphrase: "Test SDF Future Network ; October 2022",
  },
};

const DEFAULT_REQUIRED_LOCALES = ["en"];

const DEFAULT_REQUIRED_KEYS = [
  "payment.status.pending",
  "payment.status.completed",
  "payment.status.failed",
  "payment.error.insufficient_funds",
  "payment.error.invalid_destination",
  "compliance.kyc.required",
  "compliance.aml.flagged",
  "compliance.disclaimer",
];

function resolveStellarNetwork(): StellarConfig["network"] {
  const raw = (process.env.STELLAR_NETWORK || "testnet").toLowerCase();
  if (raw === "testnet" || raw === "public" || raw === "futurenet") {
    return raw;
  }
  throw new Error(
    `Invalid STELLAR_NETWORK "${raw}". Expected one of: testnet, public, futurenet.`
  );
}

function resolveAssetCode(): string {
  const code = (process.env.STELLAR_ASSET_CODE || "").trim();
  if (!code) {
    throw new Error("STELLAR_ASSET_CODE is required for Stellar payouts.");
  }
  if (!/^[A-Za-z0-9]{1,12}$/.test(code)) {
    throw new Error(
      `Invalid STELLAR_ASSET_CODE "${code}". Asset codes must be 1-12 alphanumeric characters.`
    );
  }
  return code;
}

function resolveAssetIssuer(): string {
  const issuer = (process.env.STELLAR_ASSET_ISSUER || "").trim();
  if (!issuer) {
    throw new Error("STELLAR_ASSET_ISSUER is required for Stellar payouts.");
  }
  if (!/^G[A-Z2-7]{55}$/.test(issuer)) {
    throw new Error(
      `Invalid STELLAR_ASSET_ISSUER "${issuer}". Expected a Stellar account ID (G...).`
    );
  }
  return issuer;
}

function resolvePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Invalid ${name} "${raw}". Expected a positive integer.`
    );
  }
  return value;
}

function resolveList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const values = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return values.length > 0 ? values : fallback;
}

function resolveBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  return raw.trim().toLowerCase() === "true";
}

function resolveTimezone(name: string, fallback: string): string {
  const raw = process.env[name];
  const candidate = raw === undefined || raw.trim() === "" ? fallback : raw.trim();
  try {
    // Throws RangeError for unknown IANA zones, so misconfiguration fails fast.
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
  } catch {
    throw new Error(
      `Invalid ${name} "${candidate}". Expected an IANA timezone (e.g. "America/New_York").`
    );
  }
  return candidate;
}

const stellarNetwork = resolveStellarNetwork();
const stellarNetworkDefaults = STELLAR_NETWORKS[stellarNetwork];

export const config: Config = {
  port: Number(process.env.PORT) || 3000,
  bridgeApiUrl: process.env.BRIDGE_API_URL || "",
  bridgeApiKey: process.env.BRIDGE_API_KEY || "",
  webhookSecret: process.env.WEBHOOK_SECRET || "",
  stellar: {
    network: stellarNetwork,
    horizonUrl: process.env.STELLAR_HORIZON_URL || stellarNetworkDefaults.horizonUrl,
    networkPassphrase:
      process.env.STELLAR_NETWORK_PASSPHRASE || stellarNetworkDefaults.networkPassphrase,
    assetCode: resolveAssetCode(),
    assetIssuer: resolveAssetIssuer(),
  },
  soroban: {
    rpcUrl: process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org",
    contractId: process.env.SOROBAN_CONTRACT_ID || "",
    maxFeeStroops: resolvePositiveInt("SOROBAN_MAX_FEE_STROOPS", 1_000_000),
    maxInstructions: resolvePositiveInt("SOROBAN_MAX_INSTRUCTIONS", 100_000_000),
    maxCpuInsns: resolvePositiveInt("SOROBAN_MAX_CPU_INSNS", 100_000_000),
    maxMemoryBytes: resolvePositiveInt("SOROBAN_MAX_MEMORY_BYTES", 41_943_040),
    maxRetries: resolvePositiveInt("SOROBAN_MAX_RETRIES", 3),
    retryBaseDelayMs: resolvePositiveInt("SOROBAN_RETRY_BASE_DELAY_MS", 500),
    retryMaxDelayMs: resolvePositiveInt("SOROBAN_RETRY_MAX_DELAY_MS", 8_000),
  },
  i18n: {
    requiredLocales: resolveList("I18N_REQUIRED_LOCALES", DEFAULT_REQUIRED_LOCALES),
    fallbackLocale: process.env.I18N_FALLBACK_LOCALE || "en",
    requiredKeys: resolveList("I18N_REQUIRED_KEYS", DEFAULT_REQUIRED_KEYS),
    alertOnCriticalFallback: resolveBoolean("I18N_ALERT_ON_CRITICAL_FALLBACK", true),
  },
  reporting: {
    defaultTimezone: resolveTimezone("REPORTING_DEFAULT_TIMEZONE", "UTC"),
  },
};
