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

interface SchedulerConfig {
  /** Unique identity for this replica, used as the lock owner. */
  replicaId: string;
  /** How long a job lease is held before it must be renewed. */
  leaseTtlMs: number;
  /** How often the lease holder renews its lease. */
  leaseRenewIntervalMs: number;
  /** Redis URL used for distributed job locks. Empty disables distributed locking. */
  redisUrl: string;
  /** Key prefix for scheduler lock keys. */
  lockKeyPrefix: string;
}

interface MonitoringConfig {
  /** Sentry DSN. Empty disables Sentry export. */
  sentryDsn: string;
  /** Environment tag attached to exported events. */
  environment: string;
  /** Fraction of transactions sampled for tracing (0-1). */
  tracesSampleRate: number;
  /** When true, request/response bodies are scrubbed before logging. */
  scrubRequestData: boolean;
}

interface Config {
  port: number;
  bridgeApiUrl: string;
  bridgeApiKey: string;
  webhookSecret: string;
  stellar: StellarConfig;
  soroban: SorobanConfig;
  scheduler: SchedulerConfig;
  monitoring: MonitoringConfig;
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

function resolveSampleRate(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `Invalid ${name} "${raw}". Expected a number between 0 and 1.`
    );
  }
  return value;
}

function resolveBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(
    `Invalid ${name} "${raw}". Expected a boolean (true/false).`
  );
}

function resolveReplicaId(): string {
  const raw = (process.env.SCHEDULER_REPLICA_ID || "").trim();
  if (raw) {
    return raw;
  }
  return `${process.env.HOSTNAME || "replica"}-${process.pid}`;
}

const stellarNetwork = resolveStellarNetwork();
const stellarNetworkDefaults = STELLAR_NETWORKS[stellarNetwork];

const schedulerLeaseTtlMs = resolvePositiveInt("SCHEDULER_LEASE_TTL_MS", 30_000);
const schedulerLeaseRenewIntervalMs = resolvePositiveInt(
  "SCHEDULER_LEASE_RENEW_INTERVAL_MS",
  Math.max(1, Math.floor(schedulerLeaseTtlMs / 3))
);

if (schedulerLeaseRenewIntervalMs >= schedulerLeaseTtlMs) {
  throw new Error(
    `Invalid SCHEDULER_LEASE_RENEW_INTERVAL_MS "${schedulerLeaseRenewIntervalMs}". ` +
      `Must be less than SCHEDULER_LEASE_TTL_MS "${schedulerLeaseTtlMs}".`
  );
}

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
  scheduler: {
    replicaId: resolveReplicaId(),
    leaseTtlMs: schedulerLeaseTtlMs,
    leaseRenewIntervalMs: schedulerLeaseRenewIntervalMs,
    redisUrl: process.env.SCHEDULER_REDIS_URL || process.env.REDIS_URL || "",
    lockKeyPrefix: process.env.SCHEDULER_LOCK_KEY_PREFIX || "scheduler:lock:",
  },
  monitoring: {
    sentryDsn: process.env.SENTRY_DSN || "",
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
    tracesSampleRate: resolveSampleRate("SENTRY_TRACES_SAMPLE_RATE", 0),
    scrubRequestData: resolveBoolean("MONITORING_SCRUB_REQUEST_DATA", true),
  },
};
