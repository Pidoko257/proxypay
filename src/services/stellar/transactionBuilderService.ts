import * as StellarSdk from "stellar-sdk";
import { getStellarServer, getNetworkPassphrase } from "../../config/stellar";

// ── TypeScript Interfaces ───────────────────────────────────────────────────────

export interface PaymentParams {
  /** Keypair of the account sending the payment */
  sourceKeypair: StellarSdk.Keypair;
  /** Destination Stellar account (supports both G and M addresses) */
  destination: string;
  /** Asset to send */
  asset: StellarSdk.Asset;
  /** Amount to send */
  amount: string;
  /** Optional memo for the transaction */
  memo?: StellarSdk.Memo;
  /** Optional fee override in stroops (defaults to fetched base fee) */
  feeOverride?: string;
  /** Optional timeout in seconds (defaults to 30) */
  timeout?: number;
}

export interface PathPaymentParams {
  /** Keypair of the account sending the payment */
  sourceKeypair: StellarSdk.Keypair;
  /** Destination Stellar account */
  destination: string;
  /** Asset the sender spends */
  sendAsset: StellarSdk.Asset;
  /** Asset the destination receives */
  destAsset: StellarSdk.Asset;
  /** Exact amount the destination must receive */
  destAmount: string;
  /** Maximum the sender is willing to spend (slippage guard) */
  sendMax: string;
  /** Optional intermediate assets for the path */
  path?: StellarSdk.Asset[];
  /** Optional memo for the transaction */
  memo?: StellarSdk.Memo;
  /** Optional fee override in stroops (defaults to fetched base fee) */
  feeOverride?: string;
  /** Optional timeout in seconds (defaults to 30) */
  timeout?: number;
}

export interface ChangeTrustParams {
  /** Keypair of the account creating/modifying the trustline */
  sourceKeypair: StellarSdk.Keypair;
  /** Asset to trust */
  asset: StellarSdk.Asset;
  /** Trustline limit (defaults to max) */
  limit?: string;
  /** Optional memo for the transaction */
  memo?: StellarSdk.Memo;
  /** Optional fee override in stroops (defaults to fetched base fee) */
  feeOverride?: string;
  /** Optional timeout in seconds (defaults to 30) */
  timeout?: number;
}

export interface ManageDataParams {
  /** Keypair of the account managing data */
  sourceKeypair: StellarSdk.Keypair;
  /** Data entry name (64 char max) */
  name: string;
  /** Data value (up to 64 bytes, or null to delete) */
  value: string | Buffer | null;
  /** Optional memo for the transaction */
  memo?: StellarSdk.Memo;
  /** Optional fee override in stroops (defaults to fetched base fee) */
  feeOverride?: string;
  /** Optional timeout in seconds (defaults to 30) */
  timeout?: number;
}

export interface TransactionBuildResult {
  /** The built transaction (unsigned) */
  transaction: StellarSdk.Transaction;
  /** The fee used in stroops */
  fee: string;
  /** The sequence number used */
  sequence: string;
}

export interface SignedTransactionResult {
  /** The signed transaction ready for submission */
  signedTransaction: StellarSdk.Transaction;
  /** The transaction hash */
  hash: string;
  /** The fee used in stroops */
  fee: string;
}

// ── Error Types ─────────────────────────────────────────────────────────────────

export class SequenceMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SequenceMismatchError";
  }
}

export class TransactionBuilderError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = "TransactionBuilderError";
  }
}

// ── Transaction Builder Service ───────────────────────────────────────────────────

export class TransactionBuilderService {
  private server: StellarSdk.Horizon.Server;
  private networkPassphrase: string;
  private readonly DEFAULT_TIMEOUT = 30;
  private readonly MAX_SEQUENCE_RETRIES = 3;
  private readonly SEQUENCE_RETRY_DELAY_MS = 1000;

  constructor() {
    this.server = getStellarServer();
    this.networkPassphrase = getNetworkPassphrase();
  }

  /**
   * Fetch the current base fee from Horizon.
   * @returns The base fee in stroops as a string
   */
  private async fetchBaseFee(): Promise<string> {
    try {
      const baseFee = await this.server.fetchBaseFee();
      return baseFee.toString();
    } catch (error) {
      console.warn("Failed to fetch base fee from Horizon, using SDK default", error);
      return StellarSdk.BASE_FEE.toString();
    }
  }

  /**
   * Load an account from Horizon with sequence number retry logic.
   * @param publicKey - The account public key
   * @param retryCount - Current retry count for sequence mismatches
   * @returns The account record
   */
  private async loadAccountWithRetry(
    publicKey: string,
    retryCount: number = 0,
  ): Promise<StellarSdk.Horizon.AccountResponse> {
    try {
      return await this.server.loadAccount(publicKey);
    } catch (error: unknown) {
      const err = error as { response?: { data?: { extras?: { result_codes?: { transaction?: string } } } } };
      
      // Check if this is a sequence mismatch error
      const txResult = err.response?.data?.extras?.result_codes?.transaction;
      if (txResult === "tx_bad_seq" && retryCount < this.MAX_SEQUENCE_RETRIES) {
        console.log(
          `Sequence mismatch detected (attempt ${retryCount + 1}/${this.MAX_SEQUENCE_RETRIES}), retrying...`
        );
        // Wait before retrying to allow network to settle
        await new Promise((resolve) => 
          setTimeout(resolve, this.SEQUENCE_RETRY_DELAY_MS * (retryCount + 1))
        );
        return this.loadAccountWithRetry(publicKey, retryCount + 1);
      }
      
      throw error;
    }
  }

  /**
   * Build a transaction with the specified operations.
   * @param sourceKeypair - The source account keypair
   * @param operations - Array of operations to include
   * @param options - Transaction options (memo, fee, timeout)
   * @returns The built transaction
   */
  private async buildTransaction(
    sourceKeypair: StellarSdk.Keypair,
    operations: StellarSdk.Operation[],
    options: {
      memo?: StellarSdk.Memo;
      feeOverride?: string;
      timeout?: number;
    } = {},
  ): Promise<TransactionBuildResult> {
    const { memo, feeOverride, timeout = this.DEFAULT_TIMEOUT } = options;

    // Fetch fee or use override
    const fee = feeOverride || await this.fetchBaseFee();

    // Load account with sequence retry logic
    const account = await this.loadAccountWithRetry(sourceKeypair.publicKey());

    // Build transaction
    let builder = new StellarSdk.TransactionBuilder(account, {
      fee,
      timebounds: await this.server.fetchTimebounds(timeout),
      networkPassphrase: this.networkPassphrase,
    });

    // Add memo if provided
    if (memo) {
      builder = builder.addMemo(memo);
    }

    // Add operations
    for (const operation of operations) {
      builder = builder.addOperation(operation);
    }

    const transaction = builder.build();

    return {
      transaction,
      fee,
      sequence: account.sequence,
    };
  }

  /**
   * Build a payment transaction.
   * @param params - Payment parameters
   * @returns The built transaction (unsigned)
   */
  async buildPayment(params: PaymentParams): Promise<TransactionBuildResult> {
    const { sourceKeypair, destination, asset, amount, memo, feeOverride, timeout } = params;

    const operation = StellarSdk.Operation.payment({
      destination,
      asset,
      amount,
    });

    return this.buildTransaction(sourceKeypair, [operation], {
      memo,
      feeOverride,
      timeout,
    });
  }

  /**
   * Build and sign a payment transaction.
   * @param params - Payment parameters
   * @returns The signed transaction ready for submission
   */
  async buildAndSignPayment(params: PaymentParams): Promise<SignedTransactionResult> {
    const { transaction, fee } = await this.buildPayment(params);
    transaction.sign(params.sourceKeypair);
    
    return {
      signedTransaction: transaction,
      hash: transaction.hash().toString("hex"),
      fee,
    };
  }

  /**
   * Build a path payment transaction.
   * @param params - Path payment parameters
   * @returns The built transaction (unsigned)
   */
  async buildPathPayment(params: PathPaymentParams): Promise<TransactionBuildResult> {
    const {
      sourceKeypair,
      destination,
      sendAsset,
      destAsset,
      destAmount,
      sendMax,
      path = [],
      memo,
      feeOverride,
      timeout,
    } = params;

    const operation = StellarSdk.Operation.pathPaymentStrictReceive({
      sendAsset,
      sendMax,
      destination,
      destAsset,
      destAmount,
      path,
    });

    return this.buildTransaction(sourceKeypair, [operation], {
      memo,
      feeOverride,
      timeout,
    });
  }

  /**
   * Build and sign a path payment transaction.
   * @param params - Path payment parameters
   * @returns The signed transaction ready for submission
   */
  async buildAndSignPathPayment(params: PathPaymentParams): Promise<SignedTransactionResult> {
    const { transaction, fee } = await this.buildPathPayment(params);
    transaction.sign(params.sourceKeypair);
    
    return {
      signedTransaction: transaction,
      hash: transaction.hash().toString("hex"),
      fee,
    };
  }

  /**
   * Build a change trust transaction.
   * @param params - Change trust parameters
   * @returns The built transaction (unsigned)
   */
  async buildChangeTrust(params: ChangeTrustParams): Promise<TransactionBuildResult> {
    const { sourceKeypair, asset, limit, memo, feeOverride, timeout } = params;

    const operation = StellarSdk.Operation.changeTrust({
      asset,
      limit: limit || "922337203685.4775807", // Max trustline limit
    });

    return this.buildTransaction(sourceKeypair, [operation], {
      memo,
      feeOverride,
      timeout,
    });
  }

  /**
   * Build and sign a change trust transaction.
   * @param params - Change trust parameters
   * @returns The signed transaction ready for submission
   */
  async buildAndSignChangeTrust(params: ChangeTrustParams): Promise<SignedTransactionResult> {
    const { transaction, fee } = await this.buildChangeTrust(params);
    transaction.sign(params.sourceKeypair);
    
    return {
      signedTransaction: transaction,
      hash: transaction.hash().toString("hex"),
      fee,
    };
  }

  /**
   * Build a manage data transaction.
   * @param params - Manage data parameters
   * @returns The built transaction (unsigned)
   */
  async buildManageData(params: ManageDataParams): Promise<TransactionBuildResult> {
    const { sourceKeypair, name, value, memo, feeOverride, timeout } = params;

    const operation = StellarSdk.Operation.manageData({
      name,
      value,
    });

    return this.buildTransaction(sourceKeypair, [operation], {
      memo,
      feeOverride,
      timeout,
    });
  }

  /**
   * Build and sign a manage data transaction.
   * @param params - Manage data parameters
   * @returns The signed transaction ready for submission
   */
  async buildAndSignManageData(params: ManageDataParams): Promise<SignedTransactionResult> {
    const { transaction, fee } = await this.buildManageData(params);
    transaction.sign(params.sourceKeypair);
    
    return {
      signedTransaction: transaction,
      hash: transaction.hash().toString("hex"),
      fee,
    };
  }

  /**
   * Submit a signed transaction to Horizon.
   * @param signedTransaction - The signed transaction to submit
   * @returns The submission response
   */
  async submitTransaction(
    signedTransaction: StellarSdk.Transaction,
  ): Promise<StellarSdk.Horizon.HorizonApi.SubmitTransactionResponse> {
    try {
      const response = await this.server.submitTransaction(signedTransaction);
      console.log("Transaction submitted successfully", {
        hash: response.hash,
        ledger: response.ledger,
      });
      return response;
    } catch (error) {
      console.error("Transaction submission failed", error);
      throw error;
    }
  }

  /**
   * Build, sign, and submit a payment transaction in one call.
   * @param params - Payment parameters
   * @returns The submission response
   */
  async executePayment(
    params: PaymentParams,
  ): Promise<StellarSdk.Horizon.HorizonApi.SubmitTransactionResponse> {
    const { signedTransaction } = await this.buildAndSignPayment(params);
    return this.submitTransaction(signedTransaction);
  }

  /**
   * Build, sign, and submit a path payment transaction in one call.
   * @param params - Path payment parameters
   * @returns The submission response
   */
  async executePathPayment(
    params: PathPaymentParams,
  ): Promise<StellarSdk.Horizon.HorizonApi.SubmitTransactionResponse> {
    const { signedTransaction } = await this.buildAndSignPathPayment(params);
    return this.submitTransaction(signedTransaction);
  }

  /**
   * Build, sign, and submit a change trust transaction in one call.
   * @param params - Change trust parameters
   * @returns The submission response
   */
  async executeChangeTrust(
    params: ChangeTrustParams,
  ): Promise<StellarSdk.Horizon.HorizonApi.SubmitTransactionResponse> {
    const { signedTransaction } = await this.buildAndSignChangeTrust(params);
    return this.submitTransaction(signedTransaction);
  }

  /**
   * Build, sign, and submit a manage data transaction in one call.
   * @param params - Manage data parameters
   * @returns The submission response
   */
  async executeManageData(
    params: ManageDataParams,
  ): Promise<StellarSdk.Horizon.HorizonApi.SubmitTransactionResponse> {
    const { signedTransaction } = await this.buildAndSignManageData(params);
    return this.submitTransaction(signedTransaction);
  }
}

// Export singleton instance
export const transactionBuilderService = new TransactionBuilderService();
