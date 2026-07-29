import React, { useState, useCallback } from 'react';
import { BalanceDisplay } from './BalanceDisplay';
import { OperationsHistory } from './OperationsHistory';
import { AccountFlags } from './AccountFlags';
import { useStellarAccount } from './useStellarAccount';
import { StellarAccountViewerProps, StellarAccountError } from './types';
import styles from './StellarAccountViewer.module.css';

/**
 * Copy text to clipboard with visual feedback
 */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    // Fallback for older browsers
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}

/**
 * StellarAccountViewer Component
 *
 * Main component that displays comprehensive Stellar account information
 * including balance, recent operations, and account flags.
 * 
 * Features:
 * - Real-time account data fetching from Stellar Horizon API
 * - Auto-refresh capability with configurable intervals
 * - Graceful handling of unfunded accounts
 * - Recent operations history with links to stellar.expert
 * - Account flags with descriptions
 * - Manual refresh button
 * - Copy-to-clipboard account ID
 * - Responsive design with loading and error states
 * 
 * @example
 * <StellarAccountViewer
 *   accountId="GBRPYHIL2CI3CXUASAJXLY242ZLBXNBEJRVW3RRVQPLQHPD4UO5W7FXE"
 *   autoRefresh={true}
 *   autoRefreshInterval={30000}
 *   showOperations={true}
 *   operationLimit={10}
 *   network="testnet"
 * />
 */
export const StellarAccountViewer: React.FC<StellarAccountViewerProps> = ({
  accountId,
  autoRefresh = true,
  autoRefreshInterval = 30000,
  onError,
  onAccountLoaded,
  showOperations = true,
  operationLimit = 10,
  network = 'testnet',
  className,
}) => {
  const [copied, setCopied] = useState(false);
  const [xlmPrice, setXlmPrice] = useState<number | undefined>();

  const {
    account,
    xlmBalance,
    operations,
    isLoading,
    isFetching,
    error,
    isUnfunded,
    refetch,
    refreshAccount,
    refreshOperations,
  } = useStellarAccount({
    accountId,
    autoRefreshInterval: autoRefresh ? autoRefreshInterval : 0,
    operationLimit,
    network,
  });

  // Notify parent of errors
  React.useEffect(() => {
    if (error && onError) {
      onError(error);
    }
  }, [error, onError]);

  // Notify parent when account is loaded
  React.useEffect(() => {
    if (account && onAccountLoaded) {
      onAccountLoaded(account);
    }
  }, [account, onAccountLoaded]);

  // Fetch XLM price for display (optional enhancement)
  React.useEffect(() => {
    const fetchXlmPrice = async () => {
      try {
        const response = await fetch(
          'https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd',
          { cache: 'force-cache' },
        );
        const data = await response.json();
        setXlmPrice(data.stellar?.usd);
      } catch {
        // Silently fail - price is optional
      }
    };

    fetchXlmPrice();
  }, []);

  /**
   * Handle copy account ID
   */
  const handleCopyId = useCallback(async () => {
    await copyToClipboard(accountId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [accountId]);

  /**
   * Handle manual refresh
   */
  const handleRefresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  // Loading state
  if (isLoading) {
    return (
      <div className={`${styles.container} ${className || ''}`}>
        <div className={styles.loading}>
          <div className={styles.spinner} />
          <p>Loading account data...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error && !isUnfunded) {
    const isCriticalError = error instanceof Error &&
      (error.message.includes('timeout') ||
        error.message.includes('rate limit') ||
        error.message.includes('network'));

    return (
      <div className={`${styles.container} ${className || ''}`}>
        <div className={styles.header}>
          <h1 className={styles.title}>Stellar Account</h1>
          <button
            onClick={handleRefresh}
            disabled={isFetching}
            className={`${styles.button} ${styles.buttonSecondary}`}
            title="Refresh account data"
          >
            {isFetching ? '↻ Refreshing...' : '↻ Refresh'}
          </button>
        </div>

        <div className={styles.error}>
          <div className={styles.errorTitle}>⚠️ Failed to Load Account</div>
          <div className={styles.errorMessage}>
            {error.message || 'An unexpected error occurred'}
          </div>
          {isCriticalError && (
            <div className={styles.errorMessage} style={{ marginTop: '0.5rem' }}>
              The Stellar network may be temporarily unavailable. Please try again.
            </div>
          )}
        </div>
      </div>
    );
  }

  // Unfunded account state
  if (isUnfunded) {
    return (
      <div className={`${styles.container} ${className || ''}`}>
        <div className={styles.header}>
          <h1 className={styles.title}>Stellar Account</h1>
          <button
            onClick={handleRefresh}
            disabled={isFetching}
            className={`${styles.button} ${styles.buttonSecondary}`}
            title="Refresh account data"
          >
            {isFetching ? '↻ Refreshing...' : '↻ Refresh'}
          </button>
        </div>

        <div className={styles.unfunded}>
          <div className={styles.unfundedIcon}>🚀</div>
          <h2 className={styles.unfundedTitle}>Account Not Yet Created</h2>
          <p className={styles.unfundedMessage}>
            This Stellar account exists but hasn't been funded yet.
            Send at least 1 XLM to activate it.
          </p>
          <div className={styles.fundingAddress}>
            <strong>Send XLM to:</strong>
            <div style={{ marginTop: '0.5rem', wordBreak: 'break-all' }}>
              {accountId}
            </div>
            <button
              onClick={handleCopyId}
              className={`${styles.button} ${styles.buttonSecondary}`}
              style={{ marginTop: '1rem', width: '100%' }}
              title="Copy account address to clipboard"
            >
              {copied ? '✓ Copied!' : '📋 Copy Address'}
            </button>
          </div>
          <p className={styles.unfundedMessage} style={{ marginTop: '1rem' }}>
            ℹ️ After funding, this account will appear here. You can then manage
            assets, trustlines, and perform transactions on the Stellar network.
          </p>
        </div>
      </div>
    );
  }

  // Funded account state
  return (
    <div className={`${styles.container} ${className || ''}`}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Stellar Account</h1>
          <div className={styles.accountId}>
            {accountId}
          </div>
        </div>

        <div className={styles.actions}>
          <button
            onClick={handleCopyId}
            className={`${styles.button} ${styles.buttonSecondary}`}
            title="Copy account address to clipboard"
          >
            {copied ? '✓ Copied!' : '📋 Copy'}
          </button>
          <button
            onClick={handleRefresh}
            disabled={isFetching}
            className={`${styles.button} ${styles.buttonPrimary}`}
            title="Refresh account data"
          >
            {isFetching ? '↻ Refreshing...' : '↻ Refresh'}
          </button>
          <a
            href={`https://stellar.expert/explorer/${
              accountId.length === 56 ? 'testnet' : 'public'
            }/account/${accountId}`}
            target="_blank"
            rel="noopener noreferrer"
            className={`${styles.button} ${styles.buttonSecondary}`}
            title="View on stellar.expert"
          >
            🔗 Explore
          </a>
        </div>
      </div>

      {/* Balance Display */}
      <BalanceDisplay
        balance={xlmBalance}
        isLoading={isLoading}
        error={error}
        xlmPrice={xlmPrice}
        showEquivalent={true}
        showNative={true}
      />

      {/* Account Info */}
      {account && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
          <div style={{ padding: '1rem', background: 'var(--color-background-secondary, #f5f5f5)', borderRadius: '0.5rem' }}>
            <div style={{ fontSize: '0.875rem', fontWeight: '600', color: 'var(--color-text-secondary, #666)', marginBottom: '0.5rem', textTransform: 'uppercase' }}>
              Sequence
            </div>
            <div style={{ fontFamily: "'Monaco', 'Courier New', monospace", fontSize: '1rem', fontWeight: '600' }}>
              {account.sequence}
            </div>
          </div>
          <div style={{ padding: '1rem', background: 'var(--color-background-secondary, #f5f5f5)', borderRadius: '0.5rem' }}>
            <div style={{ fontSize: '0.875rem', fontWeight: '600', color: 'var(--color-text-secondary, #666)', marginBottom: '0.5rem', textTransform: 'uppercase' }}>
              Subentries
            </div>
            <div style={{ fontFamily: "'Monaco', 'Courier New', monospace", fontSize: '1rem', fontWeight: '600' }}>
              {account.subentry_count}
            </div>
          </div>
          <div style={{ padding: '1rem', background: 'var(--color-background-secondary, #f5f5f5)', borderRadius: '0.5rem' }}>
            <div style={{ fontSize: '0.875rem', fontWeight: '600', color: 'var(--color-text-secondary, #666)', marginBottom: '0.5rem', textTransform: 'uppercase' }}>
              Signers
            </div>
            <div style={{ fontFamily: "'Monaco', 'Courier New', monospace", fontSize: '1rem', fontWeight: '600' }}>
              {account.signers.length}
            </div>
          </div>
        </div>
      )}

      {/* Account Flags */}
      {account && (
        <AccountFlags
          flags={account.flags}
          isLoading={isLoading}
          error={error}
        />
      )}

      {/* Operations History */}
      {showOperations && (
        <OperationsHistory
          operations={operations}
          isLoading={isLoading}
          error={error}
          accountId={accountId}
          limit={operationLimit}
          onLoadMore={refreshOperations}
        />
      )}

      {/* Last Updated */}
      {account && (
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary, #999)', textAlign: 'right' }}>
          Last updated: {new Date(account.last_modified_time).toLocaleString()}
        </div>
      )}
    </div>
  );
};

StellarAccountViewer.displayName = 'StellarAccountViewer';

export default StellarAccountViewer;
