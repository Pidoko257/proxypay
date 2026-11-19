import axios, { AxiosError } from "axios";
import { config } from "../config/env";
import logger from "../logger";

interface CreatePaymentPayload {
  amount: number;
  currency: string;
}

interface CreatePaymentResponse {
  id: string;
  status: string;
}

/**
 * Actionable payout validation states surfaced to callers.
 */
export type PayoutValidationState =
  | "network_mismatch"
  | "asset_issuer_mismatch"
  | "asset_code_mismatch"
  | "missing_trustline"
  | "trustline_not_authorized"
  | "account_not_found";

export class PayoutValidationError extends Error {
  readonly state: PayoutValidationState;

  constructor(state: PayoutValidationState, message: string) {
    super(message);
    this.name = "PayoutValidationError";
    this.state = state;
  }
}

interface StellarAssetConfig {
  network: string;
  assetCode: string;
  assetIssuer: string;
}

interface HorizonBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
}

interface HorizonAccountResponse {
  balances: HorizonBalance[];
}

/**
 * Resource estimates captured from a Soroban simulation before submission.
 */
export interface SorobanResourceEstimate {
  fee: number;
  cpuInsns: number;
  memBytes: number;
}

/**
 * Configurable ceilings that bound Soroban simulation/submission.
 */
export interface SorobanLimits {
  maxFee: number;
  maxCpuInsns: number;
  maxMemBytes: number;
  maxRetries: number;
  baseBackoffMs: number;
}

/**
 * Final persisted outcome of a Soroban contract execution for a job.
 */
export interface SorobanContractResult {
  jobId: string;
  success: boolean;
  attempts: number;
  estimate?: SorobanResourceEstimate;
  error?: string;
  errorClass?: "retryable" | "terminal";
  completedAt: string;
}

export class SorobanResourceLimitError extends Error {
  readonly estimate: SorobanResourceEstimate;
  readonly limits: SorobanLimits;

  constructor(estimate: SorobanResourceEstimate, limits: SorobanLimits) {
    super(
      `Soroban resource estimate exceeds configured ceilings: ` +
        `fee ${estimate.fee}/${limits.maxFee}, ` +
        `cpu ${estimate.cpuInsns}/${limits.maxCpuInsns}, ` +
        `mem ${estimate.memBytes}/${limits.maxMemBytes}`,
    );
    this.name = "SorobanResourceLimitError";
    this.estimate = estimate;
    this.limits = limits;
  }
}

/**
 * Shared provider adapter contract. Every supported provider implementation
 * (live or mock) must satisfy this surface so the contract suite can run the
 * same assertions against each one.
 */
export interface ProviderAdapter {
  readonly name: string;
  authenticate(credentials: ProviderCredentials): Promise<ProviderAuthResult>;
  createCollection(
    request: ProviderCollectionRequest,
  ): Promise<ProviderCollectionResult>;
  createPayout(request: ProviderPayoutRequest): Promise<ProviderPayoutResult>;
  getStatus(reference: string): Promise<ProviderStatusResult>;
  handleCallback(payload: ProviderCallbackPayload): ProviderCallbackResult;
  createBatch(
    requests: ProviderPayoutRequest[],
  ): Promise<ProviderBatchResult>;
}

export interface ProviderCredentials {
  apiKey: string;
  apiSecret?: string;
}

export interface ProviderAuthResult {
  authenticated: boolean;
  token?: string;
  error?: string;
}

export interface ProviderCollectionRequest {
  amount: number;
  currency: string;
  reference: string;
}

export interface ProviderCollectionResult {
  id: string;
  status: ProviderOperationStatus;
  reference: string;
}

export interface ProviderPayoutRequest {
  amount: number;
  currency: string;
  destination: string;
  reference: string;
}

export interface ProviderPayoutResult {
  id: string;
  status: ProviderOperationStatus;
  reference: string;
}

export type ProviderOperationStatus =
  | "pending"
  | "succeeded"
  | "failed";

export interface ProviderStatusResult {
  reference: string;
  status: ProviderOperationStatus;
  updatedAt: string;
}

export interface ProviderCallbackPayload {
  reference: string;
  status: ProviderOperationStatus;
  signature?: string;
}

export interface ProviderCallbackResult {
  accepted: boolean;
  reference: string;
  status: ProviderOperationStatus;
}

export interface ProviderBatchItemResult {
  reference: string;
  success: boolean;
  result?: ProviderPayoutResult;
  error?: string;
}

export interface ProviderBatchResult {
  items: ProviderBatchItemResult[];
  succeeded: number;
  failed: number;
}

const getSorobanLimits = (): SorobanLimits => {
  const env = config as unknown as Record<string, string | number | undefined>;
  const num = (value: unknown, fallback: number): number => {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    maxFee: num(env.sorobanMaxFee, 1_000_000),
    maxCpuInsns: num(env.sorobanMaxCpuInsns, 100_000_000),
    maxMemBytes: num(env.sorobanMaxMemBytes, 40_000_000),
    maxRetries: num(env.sorobanMaxRetries, 3),
    baseBackoffMs: num(env.sorobanBaseBackoffMs, 500),
  };
};

/**
 * Aborts when a simulation estimate exceeds any configured ceiling.
 */
export const enforceSorobanLimits = (
  estimate: SorobanResourceEstimate,
  limits: SorobanLimits = getSorobanLimits(),
): void => {
  if (
    estimate.fee > limits.maxFee ||
    estimate.cpuInsns > limits.maxCpuInsns ||
    estimate.memBytes > limits.maxMemBytes
  ) {
    throw new SorobanResourceLimitError(estimate, limits);
  }
};

/**
 * Classifies a Soroban error as retryable (transient network/ledger issues) or
 * terminal (resource limits, invalid contract state, auth failures).
 */
export const classifySorobanError = (
  err: unknown,
): "retryable" | "terminal" => {
  if (err instanceof SorobanResourceLimitError) {
    return "terminal";
  }
  const message = (err as Error)?.message ?? String(err);
  const retryablePatterns = [
    /timeout/i,
    /timed out/i,
    /ECONNRESET/i,
    /ECONNREFUSED/i,
    /ETIMEDOUT/i,
    /try again/i,
    /tx_bad_seq/i,
    /rate limit/i,
    /503/,
    /502/,
    /504/,
  ];
  return retryablePatterns.some((pattern) => pattern.test(message))
    ? "retryable"
    : "terminal";
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs a Soroban contract execution with bounded retries and backoff.
 * Captures the simulation estimate, enforces fee/gas ceilings, classifies
 * errors, and persists the final contract result for the job.
 */
export const executeSorobanContract = async (
  jobId: string,
  simulate: () => Promise<SorobanResourceEstimate>,
  submit: (estimate: SorobanResourceEstimate) => Promise<void>,
  persist: (result: SorobanContractResult) => Promise<void>,
  limits: SorobanLimits = getSorobanLimits(),
): Promise<SorobanContractResult> => {
  let attempts = 0;
  let estimate: SorobanResourceEstimate | undefined;

  while (attempts <= limits.maxRetries) {
    attempts += 1;
    try {
      estimate = await simulate();
      enforceSorobanLimits(estimate, limits);
      await submit(estimate);

      const result: SorobanContractResult = {
        jobId,
        success: true,
        attempts,
        estimate,
        completedAt: new Date().toISOString(),
      };
      await persist(result);
      logger.info({ jobId, attempts, estimate }, "Soroban contract executed");
      return result;
    } catch (err) {
      const errorClass = classifySorobanError(err);
      const message = (err as Error)?.message ?? String(err);

      logger.warn(
        { jobId, attempts, errorClass, err: message },
        "Soroban contract execution attempt failed",
      );

      if (errorClass === "terminal" || attempts > limits.maxRetries) {
        const result: SorobanContractResult = {
          jobId,
          success: false,
          attempts,
          estimate,
          error: message,
          errorClass,
          completedAt: new Date().toISOString(),
        };
        await persist(result);
        logger.error(
          { jobId, attempts, errorClass, err: message },
          "Soroban contract execution failed terminally",
        );
        return result;
      }

      const backoff = limits.baseBackoffMs * 2 ** (attempts - 1);
      await sleep(backoff);
    }
  }

  // Unreachable in practice; guard against unexpected loop exit.
  const result: SorobanContractResult = {
    jobId,
    success: false,
    attempts,
    estimate,
    error: "Soroban execution exhausted retries",
    errorClass: "terminal",
    completedAt: new Date().toISOString(),
  };
  await persist(result);
  return result;
};

const client = axios.create({
  baseURL: config.bridgeApiUrl,
  headers: {
    // Authorization header is redacted by the pino logger — never logged.
    Authorization: `Bearer ${config.bridgeApiKey}`,
    "Content-Type": "application/json",
  },
});

const getStellarAssetConfig = (): StellarAssetConfig => {
  const env = config as unknown as Record<string, string | undefined>;
  return {
    network: env.stellarNetwork ?? "",
    assetCode: env.stellarAssetCode ?? "",
    assetIssuer: env.stellarAssetIssuer ?? "",
  };
};

/**
 * Validates the configured Stellar network and asset (code/issuer) against the
 * expected network configuration before any payout is submitted.
 */
export const validateStellarAssetConfig = (
  expected: StellarAssetConfig,
): void => {
  const actual = getStellarAssetConfig();

  if (!actual.network || actual.network !== expected.network) {
    throw new PayoutValidationError(
      "network_mismatch",
      `Stellar network mismatch: expected "${expected.network}", got "${actual.network}"`,
    );
  }

  if (!actual.assetCode || actual.assetCode !== expected.assetCode) {
    throw new PayoutValidationError(
      "asset_code_mismatch",
      `Stellar asset code mismatch: expected "${expected.assetCode}", got "${actual.assetCode}"`,
    );
  }

  if (!actual.assetIssuer || actual.assetIssuer !== expected.assetIssuer) {
    throw new PayoutValidationError(
      "asset_issuer_mismatch",
      `Stellar asset issuer mismatch: expected "${expected.assetIssuer}", got "${actual.assetIssuer}"`,
    );
  }
};
