export interface WebhookEvent<T = any> {
  type: string;
  data: T;
}

export interface PaymentData {
  id: string;
  amount: number;
  status: string;
}

export type StellarNetwork = 'public' | 'testnet' | 'futurenet';

export interface StellarAssetConfig {
  code: string;
  issuer: string;
  network: StellarNetwork;
}

export interface StellarTrustline {
  assetCode: string;
  assetIssuer: string;
  authorized: boolean;
  authorizedToMaintainLiabilities: boolean;
  limit: string;
  balance: string;
}

export type StellarPayoutValidationErrorCode =
  | 'NETWORK_MISMATCH'
  | 'ASSET_ISSUER_MISMATCH'
  | 'ASSET_CODE_MISMATCH'
  | 'DESTINATION_NOT_FOUND'
  | 'TRUSTLINE_MISSING'
  | 'TRUSTLINE_NOT_AUTHORIZED'
  | 'TRUSTLINE_LIMIT_EXCEEDED';

export interface StellarPayoutValidationError {
  code: StellarPayoutValidationErrorCode;
  message: string;
  retryable: boolean;
}

export interface StellarPayoutValidationResult {
  valid: boolean;
  errors: StellarPayoutValidationError[];
}

/**
 * Shared provider adapter contract.
 *
 * Every supported provider implementation must satisfy this interface so the
 * reusable contract test suite can run identical assertions against each
 * provider mock and recorded sanitized API fixture.
 */
export interface ProviderAuthResult {
  authenticated: boolean;
  token?: string;
  error?: string;
}

export interface ProviderCollectionRequest {
  amount: number;
  currency: string;
  reference: string;
  customerId: string;
}

export interface ProviderCollectionResult {
  id: string;
  status: 'pending' | 'succeeded' | 'failed';
  amount: number;
  currency: string;
  error?: string;
}

export interface ProviderPayoutRequest {
  amount: number;
  currency: string;
  reference: string;
  destination: string;
}

export interface ProviderPayoutResult {
  id: string;
  status: 'pending' | 'succeeded' | 'failed';
  amount: number;
  currency: string;
  error?: string;
}

export interface ProviderStatusResult {
  id: string;
  status: 'pending' | 'succeeded' | 'failed';
  updatedAt: string;
}

export interface ProviderCallbackResult {
  handled: boolean;
  eventType: string;
  reference?: string;
}

export interface ProviderBatchItemResult<T> {
  reference: string;
  success: boolean;
  result?: T;
  error?: string;
}

export interface ProviderBatchResult<T> {
  items: ProviderBatchItemResult<T>[];
  succeeded: number;
  failed: number;
}

export interface ProviderAdapter {
  readonly name: string;
  authenticate(credentials: Record<string, string>): Promise<ProviderAuthResult>;
  collect(request: ProviderCollectionRequest): Promise<ProviderCollectionResult>;
  payout(request: ProviderPayoutRequest): Promise<ProviderPayoutResult>;
  getStatus(id: string): Promise<ProviderStatusResult>;
  handleCallback(payload: unknown): Promise<ProviderCallbackResult>;
  collectBatch(
    requests: ProviderCollectionRequest[],
  ): Promise<ProviderBatchResult<ProviderCollectionResult>>;
  payoutBatch(
    requests: ProviderPayoutRequest[],
  ): Promise<ProviderBatchResult<ProviderPayoutResult>>;
}
