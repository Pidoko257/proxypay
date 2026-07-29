/**
 * Stellar Account Viewer - Type Definitions
 * Comprehensive types for account data, operations, and balances from Horizon API
 */

/**
 * Stellar account balance information
 */
export interface Balance {
  balance: string;
  limit?: string;
  asset_type: 'native' | 'credit_alphanum4' | 'credit_alphanum12';
  asset_code?: string;
  asset_issuer?: string;
  last_modified_ledger?: number;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
  sponsor?: string;
}

/**
 * Account flags from Stellar
 */
export interface AccountFlags {
  auth_required: boolean;
  auth_revocable: boolean;
  auth_immutable: boolean;
  clawback_enabled: boolean;
}

/**
 * Signer on the account
 */
export interface Signer {
  key: string;
  weight: number;
  type: 'ed25519_public_key' | 'sha256_hash' | 'preauth_tx';
}

/**
 * Stellar account data from Horizon API
 */
export interface StellarAccount {
  id: string;
  account_id: string;
  balances: Balance[];
  subentry_count: number;
  last_modified_ledger: number;
  last_modified_time: string;
  thresholds: {
    low_threshold: number;
    med_threshold: number;
    high_threshold: number;
  };
  flags: AccountFlags;
  signers: Signer[];
  data: Record<string, string>;
  sequence: string;
  sequence_ledger: number;
  sequence_time: string;
  sponsor?: string;
  num_sponsoring: number;
  num_sponsored: number;
  home_domain?: string;
}

/**
 * Operation types supported by Stellar
 */
export type OperationType =
  | 'create_account'
  | 'payment'
  | 'path_payment_strict_receive'
  | 'path_payment_strict_send'
  | 'manage_sell_offer'
  | 'manage_buy_offer'
  | 'create_passive_sell_offer'
  | 'set_options'
  | 'change_trust'
  | 'allow_trust'
  | 'account_merge'
  | 'inflation'
  | 'manage_data'
  | 'bump_sequence'
  | 'manage_buy_offer'
  | 'path_payment_strict_receive'
  | 'claim_claimable_balance'
  | 'clawback'
  | 'clawback_claimable_balance'
  | 'set_trust_line_flags'
  | 'liquidity_pool_deposit'
  | 'liquidity_pool_withdraw'
  | 'invoke_host_function'
  | 'extend_footprint_ttl'
  | 'restore_footprint';

/**
 * Single operation from account history
 */
export interface Operation {
  id: string;
  paging_token: string;
  transaction_hash: string;
  type: OperationType;
  type_i: number;
  created_at: string;
  transaction_successful: boolean;
  source_account: string;
  source_account_muxed?: string;
  source_account_muxed_id?: string;
  // Common operation fields
  [key: string]: any;
}

/**
 * Paginated operations response
 */
export interface OperationsResponse {
  _embedded: {
    records: Operation[];
  };
  _links: {
    self: { href: string };
    next: { href: string };
    prev: { href: string };
  };
}

/**
 * Hook state for account data
 */
export interface StellarAccountState {
  account: StellarAccount | null;
  xlmBalance: string | null;
  operations: Operation[];
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  lastUpdated: Date | null;
  isUnfunded: boolean;
  isFundable: boolean;
}

/**
 * Hook options for useStellarAccount
 */
export interface UseStellarAccountOptions {
  /** Stellar public key to monitor */
  accountId: string;
  /** Auto-refresh interval in milliseconds (0 to disable) */
  autoRefreshInterval?: number;
  /** Number of recent operations to fetch */
  operationLimit?: number;
  /** Stellar network: 'testnet' or 'mainnet' */
  network?: 'testnet' | 'mainnet';
  /** Custom Horizon server URL */
  horizonUrl?: string;
  /** Enable verbose logging */
  debug?: boolean;
}

/**
 * Hook return type for useStellarAccount
 */
export interface UseStellarAccountReturn extends StellarAccountState {
  refetch: () => Promise<void>;
  refreshAccount: () => Promise<void>;
  refreshOperations: () => Promise<void>;
  reset: () => void;
}

/**
 * Component props for main viewer
 */
export interface StellarAccountViewerProps {
  accountId: string;
  autoRefresh?: boolean;
  autoRefreshInterval?: number;
  onError?: (error: Error) => void;
  onAccountLoaded?: (account: StellarAccount) => void;
  showOperations?: boolean;
  operationLimit?: number;
  network?: 'testnet' | 'mainnet';
  className?: string;
}

/**
 * Props for balance display component
 */
export interface BalanceDisplayProps {
  balance: string | null;
  isLoading: boolean;
  error: Error | null;
  xlmPrice?: number;
  showEquivalent?: boolean;
  showNative?: boolean;
}

/**
 * Props for operations history component
 */
export interface OperationsHistoryProps {
  operations: Operation[];
  isLoading: boolean;
  error: Error | null;
  accountId: string;
  limit?: number;
  onLoadMore?: () => Promise<void>;
}

/**
 * Props for account flags component
 */
export interface AccountFlagsProps {
  flags: AccountFlags | null;
  isLoading: boolean;
  error: Error | null;
}

/**
 * Formatted operation for display
 */
export interface FormattedOperation {
  id: string;
  type: OperationType;
  timestamp: Date;
  description: string;
  amount?: string;
  asset?: string;
  counterparty?: string;
  status: 'success' | 'failed';
  link: string;
}

/**
 * Account state for UI rendering
 */
export type AccountViewState =
  | 'loading'
  | 'unfunded'
  | 'funded'
  | 'error';

/**
 * Horizon server configuration
 */
export interface HorizonConfig {
  url: string;
  network: 'testnet' | 'mainnet';
  timeout?: number;
}

/**
 * Account fetch options
 */
export interface FetchAccountOptions {
  includeOperations?: boolean;
  operationLimit?: number;
  timeout?: number;
}

/**
 * Error types for account operations
 */
export enum StellarAccountError {
  ACCOUNT_NOT_FOUND = 'ACCOUNT_NOT_FOUND',
  NETWORK_ERROR = 'NETWORK_ERROR',
  INVALID_ACCOUNT_ID = 'INVALID_ACCOUNT_ID',
  OPERATIONS_FETCH_FAILED = 'OPERATIONS_FETCH_FAILED',
  TIMEOUT = 'TIMEOUT',
  RATE_LIMITED = 'RATE_LIMITED',
  UNKNOWN = 'UNKNOWN',
}

/**
 * Custom error class for Stellar operations
 */
export class StellarAccountViewerError extends Error {
  constructor(
    public code: StellarAccountError,
    message: string,
    public context?: Record<string, any>,
  ) {
    super(message);
    this.name = 'StellarAccountViewerError';
    Object.setPrototypeOf(this, StellarAccountViewerError.prototype);
  }
}
