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

const isProduction = process.env.NODE_ENV === "production";

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

function resolveIntInRange(
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const value = resolvePositiveInt(name, fallback);
  if (value < min || value > max) {
    throw new Error(
      `Invalid ${name} "${value}". Expected an integer between ${min} and ${max}.`
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
  const concurrency = resolveIntInRange(
    `${prefix}_CONCURRENCY`,
    defaults.concurrency,
    1,
    1_000
  );
  const capacity = resolveIntInRange(
    `${prefix}_CAPACITY`,
    defaults.capacity,
    1,
    1_000_000
  );
  const providerRatePerSecond = resolveIntInRange(
    `${prefix}_PROVIDER_RATE_PER_SECOND`,
    defaults.providerRatePerSecond,
    1,
    100_000
  );
  const providerRateBurst = resolveIntInRange(
    `${prefix}_PROVIDER_RATE_BURST`,
    defaults.providerRateBurst,
    1,
    100_000
  );
  if (providerRateBurst < providerRatePerSecond) {
    throw new Error(
      `Invalid ${prefix}_PROVIDER_RATE_BURST "${providerRateBurst}". Must be >= ${prefix}_PROVIDER_RATE_PER_SECOND (${providerRatePerSecond}).`
    );
  }
  if (concurrency > capacity) {
    throw new Error(
      `Invalid ${prefix}_CONCURRENCY "${concurrency}". Must be <= ${prefix}_CAPACITY (${capacity}).`
    );
  }
  return {
    concurrency,
    capacity,
    providerRatePerSecond,
    providerRateBurst,
    admission: resolveAdmissionBehavior(
      `${prefix}_ADMISSION`,
      defaults.admission
    ),
  };
}

function resolvePort(): number {
  return resolveIntInRange("PORT", 3000, 1, 65_535);
}

function resolveSorobanConfig(): SorobanConfig {
  const maxRetries = resolveIntInRange("SOROBAN_MAX_RETRIES", 3, 0, 100);
  const retryBaseDelayMs = resolveIntInRange(
    "SOROBAN_RETRY_BASE_DELAY_MS",
    500,
    1,
    600_000
  );
  const retryMaxDelayMs = resolveIntInRange(
    "SOROBAN_RETRY_MAX_DELAY_MS",
    8_000,
    1,
    600_000
  );
  if (retryMaxDelayMs < retryBaseDelayMs) {
    throw new Error(
      `Invalid SOROBAN_RETRY_MAX_DELAY_MS "${retryMaxDelayMs}". Must be >= SOROBAN_RETRY_BASE_DELAY_MS (${retryBaseDelayMs}).`
    );
  }
  return {
    rpcUrl: process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org",
    contractId: process.env.SOROBAN_CONTRACT_ID || "",
    maxFeeStroops: resolveIntInRange("SOROBAN_MAX_FEE_STROOPS", 1_000_000, 1, 1_000_000_000),
    maxInstructions: resolveIntInRange("SOROBAN_MAX_INSTRUCTIONS", 100_000_000, 1, 1_000_000_000),
    maxCpuInsns: resolveIntInRange("SOROBAN_MAX_CPU_INSNS", 100_000_000, 1, 1_000_000_000),
    maxMemoryBytes: resolveIntInRange("SOROBAN_MAX_MEMORY_BYTES", 41_943_040, 1, 1_073_741_824),
    maxRetries,
    retryBaseDelayMs,
    retryMaxDelayMs,
  };
}

function resolveRequiredInProduction(name: string, value: string): string {
  if (isProduction && !value.trim()) {
    throw new Error(`${name} is required in production.`);
  }
  return value;
}

const stellarNetwork = resolveStellarNetwork();
const stellarNetworkDefaults = STELLAR_NETWORKS[stellarNetwork];

export const config: Config = {
  port: resolvePort(),
  bridgeApiUrl: resolveRequiredInProduction(
    "BRIDGE_API_URL",
    process.env.BRIDGE_API_URL || ""
  ),
  bridgeApiKey: resolveRequiredInProduction(
    "BRIDGE_API_KEY",
    process.env.BRIDGE_API_KEY || ""
  ),
  webhookSecret: resolveRequiredInProduction(
    "WEBHOOK_SECRET",
    process.env.WEBHOOK_SECRET || ""
  ),
  stellar: {
    network: stellarNetwork,
    horizonUrl: process.env.STELLAR_HORIZON_URL || stellarNetworkDefaults.horizonUrl,
    networkPassphrase:
      process.env.STELLAR_NETWORK_PASSPHRASE || stellarNetworkDefaults.networkPassphrase,
    assetCode: resolveAssetCode(),
    assetIssuer: resolveAssetIssuer(),
  },
  soroban: resolveSorobanConfig(),
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
