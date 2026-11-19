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

type QueueAdmissionBehavior = "reject" | "defer";

interface QueuePolicy {
  concurrency: number;
  capacity: number;
  providerRatePerSecond: number;
  providerRateBurst: number;
  admission: QueueAdmissionBehavior;
}

interface QueueConfig {
  payment: QueuePolicy;
  reconciliation: QueuePolicy;
  notification: QueuePolicy;
}

interface Config {
  port: number;
  bridgeApiUrl: string;
  bridgeApiKey: string;
  webhookSecret: string;
  stellar: StellarConfig;
  soroban: SorobanConfig;
  queues: QueueConfig;
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

function resolveAdmissionBehavior(
  name: string,
  fallback: QueueAdmissionBehavior
): QueueAdmissionBehavior {
  const raw = (process.env[name] || "").trim().toLowerCase();
  if (raw === "") {
    return fallback;
  }
  if (raw === "reject" || raw === "defer") {
    return raw;
  }
  throw new Error(
    `Invalid ${name} "${raw}". Expected one of: reject, defer.`
  );
}

function resolveQueuePolicy(
  prefix: string,
  defaults: QueuePolicy
): QueuePolicy {
  return {
    concurrency: resolvePositiveInt(`${prefix}_CONCURRENCY`, defaults.concurrency),
    capacity: resolvePositiveInt(`${prefix}_CAPACITY`, defaults.capacity),
    providerRatePerSecond: resolvePositiveInt(
      `${prefix}_PROVIDER_RATE_PER_SECOND`,
      defaults.providerRatePerSecond
    ),
    providerRateBurst: resolvePositiveInt(
      `${prefix}_PROVIDER_RATE_BURST`,
      defaults.providerRateBurst
    ),
    admission: resolveAdmissionBehavior(
      `${prefix}_ADMISSION`,
      defaults.admission
    ),
  };
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
  queues: {
    payment: resolveQueuePolicy("QUEUE_PAYMENT", {
      concurrency: 4,
      capacity: 500,
      providerRatePerSecond: 20,
      providerRateBurst: 40,
      admission: "reject",
    }),
    reconciliation: resolveQueuePolicy("QUEUE_RECONCILIATION", {
      concurrency: 2,
      capacity: 200,
      providerRatePerSecond: 5,
      providerRateBurst: 10,
      admission: "defer",
    }),
    notification: resolveQueuePolicy("QUEUE_NOTIFICATION", {
      concurrency: 8,
      capacity: 1_000,
      providerRatePerSecond: 50,
      providerRateBurst: 100,
      admission: "defer",
    }),
  },
};
