import {
  Asset,
  FeeBumpTransaction,
  Keypair,
  Memo,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
} from "stellar-sdk";
import {
  getFeeBumpConfig,
  getNetworkPassphrase,
  getStellarServer,
} from "../config/stellar";

type StellarOperation = Parameters<TransactionBuilder["addOperation"]>[0];
type StellarTimebounds = { minTime: string; maxTime: string };

export interface FeeBumpOptions {
  sourceAccount: string;
  operations: StellarOperation[];
  memo?: Memo;
  timebounds?: StellarTimebounds;
  enableFeeBump?: boolean;
}

export interface FeeBumpResult {
  envelope: string;
  innerTransactionHash: string;
  feeBumpTransactionHash: string;
  fee: number;
  usedFeeBump: boolean;
}

export interface FeeEstimate {
  baseFee: number;
  operationCount: number;
  estimatedFee: number;
  maxFee: number;
  exceedsMax: boolean;
}

let feePayerSequence: number | null = null;

function assertValidPublicKey(accountId: string, fieldName: string): void {
  if (!StrKey.isValidEd25519PublicKey(accountId)) {
    throw new Error(`Invalid ${fieldName}`);
  }
}

function getChargedOperationCount(operationCount: number): number {
  return operationCount + 1;
}

function getConfiguredBaseFee(networkBaseFee: number): number {
  const config = getFeeBumpConfig();
  return Math.max(config.baseFeeStroops, networkBaseFee);
}

function getInnerTransactionFee(operationCount: number, baseFee: number): number {
  return operationCount * baseFee;
}

function getRequiredFeeBumpFee(operationCount: number, baseFee: number): number {
  return getChargedOperationCount(operationCount) * baseFee;
}

function assertFeeLimit(operationCount: number, baseFee: number): void {
  const config = getFeeBumpConfig();
  const requiredFee = getRequiredFeeBumpFee(operationCount, baseFee);

  if (requiredFee > config.maxFeePerTransaction) {
    throw new Error(
      `Fee bump fee ${requiredFee} stroops exceeds max allowed ${config.maxFeePerTransaction}`,
    );
  }
}

function getFeePayerKeypair(): Keypair {
  const config = getFeeBumpConfig();
  if (!config.feePayerPublicKey || !config.feePayerPrivateKey) {
    throw new Error("Fee payer not configured");
  }

  assertValidPublicKey(config.feePayerPublicKey, "fee payer public key");
  const feePayerKeypair = Keypair.fromSecret(config.feePayerPrivateKey);

  if (feePayerKeypair.publicKey() !== config.feePayerPublicKey) {
    throw new Error("Fee payer secret does not match configured public key");
  }

  return feePayerKeypair;
}

async function getTransactionBaseFee(): Promise<number> {
  const server = getStellarServer();
  const fetchedBaseFee = await server.fetchBaseFee();
  return getConfiguredBaseFee(Number(fetchedBaseFee));
}

async function buildInnerTransaction(
  options: FeeBumpOptions,
  baseFee: number,
): Promise<Transaction> {
  const server = getStellarServer();
  const networkPassphrase = getNetworkPassphrase();
  const sourceAccountRecord = await server.loadAccount(options.sourceAccount);
  const txTimebounds = options.timebounds ?? (await server.fetchTimebounds(300));

  let builder = new TransactionBuilder(sourceAccountRecord, {
    fee: String(getInnerTransactionFee(options.operations.length, baseFee)),
    timebounds: txTimebounds,
    networkPassphrase,
  });

  if (options.memo) {
    builder = builder.addMemo(options.memo);
  }

  for (const operation of options.operations) {
    builder = builder.addOperation(operation);
  }

  return builder.build();
}

export const wrapInFeeBump = (
  innerTransaction: Transaction,
  feePayerKeypair: Keypair,
  baseFee: number,
): FeeBumpTransaction => {
  return TransactionBuilder.buildFeeBumpTransaction(
    feePayerKeypair,
    String(baseFee),
    innerTransaction,
    getNetworkPassphrase(),
  );
};

export const buildTransactionWithFeeBump = async (
  options: FeeBumpOptions,
): Promise<FeeBumpResult> => {
  const config = getFeeBumpConfig();
  const { sourceAccount, operations, enableFeeBump = true } = options;

  assertValidPublicKey(sourceAccount, "source account address");

  if (operations.length === 0) {
    throw new Error("At least one operation is required");
  }

  if (operations.length > config.maxOperationsPerTransaction) {
    throw new Error(
      `Too many operations: ${operations.length}. Maximum is ${config.maxOperationsPerTransaction}`,
    );
  }

  const baseFee = await getTransactionBaseFee();
  const innerTransaction = await buildInnerTransaction(options, baseFee);

  if (!enableFeeBump) {
    return {
      envelope: innerTransaction.toEnvelope().toXDR("base64"),
      innerTransactionHash: innerTransaction.hash().toString("hex"),
      feeBumpTransactionHash: "",
      fee: Number(innerTransaction.fee),
      usedFeeBump: false,
    };
  }

  const feePayerKeypair = getFeePayerKeypair();
  await updateFeePayerSequence();
  assertFeeLimit(operations.length, baseFee);

  const feeBumpTransaction = wrapInFeeBump(
    innerTransaction,
    feePayerKeypair,
    baseFee,
  );

  feeBumpTransaction.sign(feePayerKeypair);

  return {
    envelope: feeBumpTransaction.toEnvelope().toXDR("base64"),
    innerTransactionHash: innerTransaction.hash().toString("hex"),
    feeBumpTransactionHash: feeBumpTransaction.hash().toString("hex"),
    fee: Number(feeBumpTransaction.fee),
    usedFeeBump: true,
  };
};

export const updateFeePayerSequence = async (): Promise<number> => {
  const config = getFeeBumpConfig();
  if (!config.feePayerPublicKey) {
    throw new Error("Fee payer not configured");
  }

  assertValidPublicKey(config.feePayerPublicKey, "fee payer public key");

  const server = getStellarServer();
  const feePayerAccount = await server.loadAccount(config.feePayerPublicKey);
  feePayerSequence = Number(feePayerAccount.sequence);

  return feePayerSequence;
};

export const getFeePayerSequence = (): number | null => feePayerSequence;

export const incrementFeePayerSequence = (): void => {
  if (feePayerSequence !== null) {
    feePayerSequence += 1;
  }
};

export const estimateFee = (operationCount: number): FeeEstimate => {
  const config = getFeeBumpConfig();
  const estimatedFee = getRequiredFeeBumpFee(
    operationCount,
    config.baseFeeStroops,
  );

  return {
    baseFee: config.baseFeeStroops,
    operationCount,
    estimatedFee,
    maxFee: config.maxFeePerTransaction,
    exceedsMax: estimatedFee > config.maxFeePerTransaction,
  };
};

export const calculateMaxFee = (
  operationCount: number,
  baseFee: number,
  maxAllowedFee: number,
): number => {
  const totalFee = getRequiredFeeBumpFee(operationCount, baseFee);
  if (totalFee > maxAllowedFee) {
    throw new Error(
      `Fee bump fee ${totalFee} stroops exceeds max allowed ${maxAllowedFee}`,
    );
  }

  return totalFee;
};

export interface SubmitTransactionResult {
  success: boolean;
  transactionHash?: string;
  envelope?: string;
  feeCharged?: number;
  resultXdr?: string;
  error?: string;
}

function parseTransactionEnvelope(
  envelope: string,
): Transaction | FeeBumpTransaction {
  return TransactionBuilder.fromXDR(envelope, getNetworkPassphrase());
}

function validateEnvelopeFeeLimit(
  transaction: Transaction | FeeBumpTransaction,
): void {
  const maxFee = getFeeBumpConfig().maxFeePerTransaction;
  if (transaction instanceof FeeBumpTransaction) {
    const fee = Number(transaction.fee);
    if (fee <= maxFee) {
      return;
    }

    throw new Error(
      `Fee bump fee ${fee} stroops exceeds max allowed ${maxFee}`,
    );
  }
}

export const submitTransaction = async (
  envelope: string,
): Promise<SubmitTransactionResult> => {
  const server = getStellarServer();
  // Retry configuration
  const MAX_NETWORK_RETRIES = 5;
  const MAX_FEE_RETRIES = 3;
  const networkBackoffBaseMs = 200;

  let networkAttempts = 0;
  let feeAttempts = 0;

  // Parse once and keep a mutable envelope/transaction for rebuilds
  let transaction = parseTransactionEnvelope(envelope);

  // Helper to decide if an error is a network/timeout transient
  const isNetworkError = (err: any): boolean => {
    const msg = (err?.message || "").toString().toLowerCase();
    if (msg.includes("timeout") || msg.includes("timedout") || msg.includes("econnreset") || msg.includes("network")) return true;
    if (err?.code === "ETIMEDOUT" || err?.code === "ECONNRESET") return true;
    const status = err?.response?.status;
    if (typeof status === "number" && status >= 500) return true;
    return false;
  };

  // Helper to extract Stellar transaction result code
  const stellarTxCode = (err: any): string | undefined =>
    err?.response?.data?.extras?.result_codes?.transaction;

  while (true) {
    try {
      validateEnvelopeFeeLimit(transaction);

      const response = await server.submitTransaction(transaction as any);

      if (transaction instanceof FeeBumpTransaction) {
        try {
          await updateFeePayerSequence();
        } catch {
          // Non-fatal if refresh fails here
        }
      }

      return {
        success: true,
        transactionHash: response.hash,
        envelope,
        feeCharged: Number((response as { fee_charged?: number | string }).fee_charged ?? (transaction as any).fee),
        resultXdr: response.result_xdr,
      };
    } catch (error: unknown) {
      const err = error as any;

      const txCode = stellarTxCode(err);

      // Sequence mismatch: refresh fee payer sequence (for fee-bumped txs) and retry
      if (txCode === "tx_bad_seq" || (err?.message || "").toString().includes("tx_bad_seq")) {
        try {
          await updateFeePayerSequence();
        } catch {
          // If refresh fails, fall through to return error below
        }

        // Re-parse envelope in case a rebuild was performed above
        try {
          transaction = parseTransactionEnvelope(envelope);
        } catch {
          // ignore parse errors here
        }

        // Retry once after sequence refresh
        networkAttempts++;
        if (networkAttempts <= MAX_NETWORK_RETRIES) {
          continue;
        }

        return {
          success: false,
          error: err.message || "tx_bad_seq",
        };
      }

      // Insufficient fee: attempt to bump fee by 20% and retry up to MAX_FEE_RETRIES
      if (txCode === "tx_insufficient_fee" || (err?.message || "").toString().includes("tx_insufficient_fee")) {
        // Only possible to rebuild fee-bumped transactions here
        if (transaction instanceof FeeBumpTransaction) {
          if (feeAttempts >= MAX_FEE_RETRIES) {
            return { success: false, error: err.message || txCode || "tx_insufficient_fee" };
          }

          feeAttempts++;

          try {
            const inner = (transaction as any).innerTransaction as Transaction;
            const chargedOpCount = getChargedOperationCount((inner as any).operations?.length ?? 0);
            const currentFee = Number((transaction as any).fee ?? 0);
            const newTotalFee = Math.ceil(currentFee * 1.2);
            const newBaseFee = Math.ceil(newTotalFee / Math.max(1, chargedOpCount));

            const feePayer = getFeePayerKeypair();

            const newFeeBump = wrapInFeeBump(inner, feePayer, newBaseFee as any);
            newFeeBump.sign(feePayer);

            // Replace transaction and envelope for next submit
            transaction = newFeeBump as any;
            envelope = newFeeBump.toEnvelope().toXDR("base64");

            // Loop to retry submission
            continue;
          } catch (rebuildErr) {
            return { success: false, error: (rebuildErr as any).message || String(rebuildErr) };
          }
        }

        // If it's not a fee-bump tx, give up
        return { success: false, error: err.message || txCode || "tx_insufficient_fee" };
      }

      // Network/transient errors: exponential backoff retry
      if (isNetworkError(err)) {
        networkAttempts++;
        if (networkAttempts > MAX_NETWORK_RETRIES) {
          return { success: false, error: err.message || "Network error" };
        }

        const delay = networkBackoffBaseMs * Math.pow(2, networkAttempts - 1);
        await new Promise((res) => setTimeout(res, delay));
        continue;
      }

      // For structured Stellar errors, return immediately with code if available
      if (txCode) {
        return { success: false, error: txCode };
      }

      // Fallback: return the error message
      return { success: false, error: err.message || "Transaction submission failed" };
    }
  }
};

export const createSimplePaymentWithFeeBump = async (
  sourceAccount: string,
  destination: string,
  asset: "native" | { code: string; issuer: string },
  amount: string,
  memo?: string,
): Promise<FeeBumpResult> => {
  const stellarAsset =
    asset === "native" ? Asset.native() : new Asset(asset.code, asset.issuer);

  return buildTransactionWithFeeBump({
    sourceAccount,
    operations: [
      Operation.payment({
        destination,
        asset: stellarAsset,
        amount,
      }) as StellarOperation,
    ],
    memo: memo ? Memo.text(memo) : undefined,
  });
};

export const createTrustAndPaymentWithFeeBump = async (
  sourceAccount: string,
  destination: string,
  assetCode: string,
  assetIssuer: string,
  amount: string,
  memo?: string,
): Promise<FeeBumpResult> => {
  const asset = new Asset(assetCode, assetIssuer);

  return buildTransactionWithFeeBump({
    sourceAccount,
    operations: [
      Operation.changeTrust({
        asset,
        limit: amount,
        source: destination,
      }) as StellarOperation,
      Operation.payment({
        destination,
        asset,
        amount,
        source: sourceAccount,
      }) as StellarOperation,
    ],
    memo: memo ? Memo.text(memo) : undefined,
  });
};

export default {
  buildTransactionWithFeeBump,
  submitTransaction,
  wrapInFeeBump,
  estimateFee,
  calculateMaxFee,
  createSimplePaymentWithFeeBump,
  createTrustAndPaymentWithFeeBump,
  updateFeePayerSequence,
  getFeePayerSequence,
  incrementFeePayerSequence,
};
