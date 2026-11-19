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
 * Bounded taxonomy for provider failures used as a Prometheus label.
 * Keep this set small and fixed so metric label cardinality stays bounded;
 * free-form error details belong in structured logs, not metric labels.
 */
export type ProviderErrorCode =
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'UPSTREAM_ERROR'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

export const PROVIDER_ERROR_CODES: readonly ProviderErrorCode[] = [
  'TIMEOUT',
  'RATE_LIMITED',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'BAD_REQUEST',
  'UPSTREAM_ERROR',
  'NETWORK_ERROR',
  'UNKNOWN',
];

/**
 * Map an arbitrary provider failure to a bounded error code.
 * The original error is preserved for structured logging by callers.
 */
export function toProviderErrorCode(error: unknown): ProviderErrorCode {
  if (error == null) {
    return 'UNKNOWN';
  }

  const err = error as { code?: unknown; status?: unknown; statusCode?: unknown; name?: unknown; message?: unknown };

  const rawCode = typeof err.code === 'string' ? err.code.toUpperCase() : undefined;
  if (rawCode && (PROVIDER_ERROR_CODES as readonly string[]).includes(rawCode)) {
    return rawCode as ProviderErrorCode;
  }

  const status = typeof err.status === 'number' ? err.status : typeof err.statusCode === 'number' ? err.statusCode : undefined;
  if (status !== undefined) {
    if (status === 401 || status === 403) return 'UNAUTHORIZED';
    if (status === 404) return 'NOT_FOUND';
    if (status === 408 || status === 504) return 'TIMEOUT';
    if (status === 429) return 'RATE_LIMITED';
    if (status >= 400 && status < 500) return 'BAD_REQUEST';
    if (status >= 500) return 'UPSTREAM_ERROR';
  }

  const name = typeof err.name === 'string' ? err.name.toUpperCase() : undefined;
  if (name === 'ABORTERROR' || name === 'TIMEOUTERROR') return 'TIMEOUT';

  const message = typeof err.message === 'string' ? err.message.toLowerCase() : '';
  if (message.includes('timeout') || message.includes('timed out')) return 'TIMEOUT';
  if (message.includes('rate limit') || message.includes('too many requests')) return 'RATE_LIMITED';
  if (message.includes('unauthorized') || message.includes('forbidden')) return 'UNAUTHORIZED';
  if (message.includes('not found')) return 'NOT_FOUND';
  if (message.includes('econnrefused') || message.includes('enotfound') || message.includes('network')) {
    return 'NETWORK_ERROR';
  }

  return 'UNKNOWN';
}
