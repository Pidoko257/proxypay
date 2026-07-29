import React, { useMemo } from 'react';
import { OperationsHistoryProps, Operation, FormattedOperation } from './types';
import styles from './StellarAccountViewer.module.css';

/**
 * Operation type to human-readable name
 */
const OPERATION_TYPE_LABELS: Record<string, string> = {
  create_account: 'Create Account',
  payment: 'Payment',
  path_payment_strict_receive: 'Path Payment (Receive)',
  path_payment_strict_send: 'Path Payment (Send)',
  manage_sell_offer: 'Manage Sell Offer',
  manage_buy_offer: 'Manage Buy Offer',
  create_passive_sell_offer: 'Passive Sell Offer',
  set_options: 'Set Options',
  change_trust: 'Change Trust',
  allow_trust: 'Allow Trust',
  account_merge: 'Account Merge',
  inflation: 'Inflation',
  manage_data: 'Manage Data',
  bump_sequence: 'Bump Sequence',
  claim_claimable_balance: 'Claim Balance',
  clawback: 'Clawback',
  clawback_claimable_balance: 'Clawback Balance',
  set_trust_line_flags: 'Set Trust Line Flags',
  liquidity_pool_deposit: 'Pool Deposit',
  liquidity_pool_withdraw: 'Pool Withdraw',
  invoke_host_function: 'Invoke Contract',
  extend_footprint_ttl: 'Extend TTL',
  restore_footprint: 'Restore Footprint',
};

/**
 * Get operation icon emoji
 */
function getOperationIcon(type: string): string {
  const iconMap: Record<string, string> = {
    create_account: '✨',
    payment: '💸',
    path_payment_strict_receive: '📥',
    path_payment_strict_send: '📤',
    manage_sell_offer: '📉',
    manage_buy_offer: '📈',
    create_passive_sell_offer: '🏷️',
    set_options: '⚙️',
    change_trust: '🤝',
    allow_trust: '✅',
    account_merge: '🔀',
    inflation: '💰',
    manage_data: '📝',
    bump_sequence: '🔢',
    claim_claimable_balance: '🎁',
    clawback: '🔙',
    clawback_claimable_balance: '🔙',
    set_trust_line_flags: '🚩',
    liquidity_pool_deposit: '💧',
    liquidity_pool_withdraw: '💧',
    invoke_host_function: '⚡',
    extend_footprint_ttl: '⏱️',
    restore_footprint: '🔄',
  };

  return iconMap[type] || '📋';
}

/**
 * Format timestamp to relative time string
 */
function formatTime(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
    });
  } catch {
    return 'unknown time';
  }
}

/**
 * Build a simple description for an operation
 */
function buildOperationDescription(op: Operation): string {
  const type = OPERATION_TYPE_LABELS[op.type] || op.type;

  // Extract relevant info from operation
  if (op.asset_code && op.amount) {
    return `${type}: ${op.amount} ${op.asset_code}`;
  }

  if (op.starting_balance) {
    return `${type}: ${op.starting_balance} XLM`;
  }

  if (op.to) {
    const to = op.to.slice(0, 8);
    return `${type} to ${to}...`;
  }

  if (op.into) {
    const into = op.into.slice(0, 8);
    return `${type} into ${into}...`;
  }

  return type;
}

/**
 * Format an operation for display
 */
function formatOperation(op: Operation): FormattedOperation {
  return {
    id: op.id,
    type: op.type,
    timestamp: new Date(op.created_at),
    description: buildOperationDescription(op),
    amount: op.amount || op.starting_balance,
    asset: op.asset_code || 'XLM',
    counterparty: op.to || op.into || op.source_account,
    status: op.transaction_successful ? 'success' : 'failed',
    link: `https://stellar.expert/explorer/${
      op.source_account?.length === 56 ? 'testnet' : 'public'
    }/op/${op.id}`,
  };
}

/**
 * OperationsHistory Component
 *
 * Displays a paginated list of recent operations from a Stellar account
 * Shows operation type, timestamp, and status with clickable links to stellar.expert
 *
 * @example
 * <OperationsHistory
 *   operations={operations}
 *   isLoading={false}
 *   error={null}
 *   accountId="GBRPYHIL2CI3..."
 *   limit={10}
 * />
 */
export const OperationsHistory: React.FC<OperationsHistoryProps> = ({
  operations,
  isLoading,
  error,
  accountId,
  limit = 10,
  onLoadMore,
}) => {
  const formattedOps = useMemo(
    () => operations.slice(0, limit).map(formatOperation),
    [operations, limit],
  );

  if (isLoading) {
    return (
      <div className={styles.operationsHistory} data-testid="operations-loading">
        <div className={styles.operationsHeader}>
          <h3>Recent Operations</h3>
        </div>
        <div className={styles.operationsContent}>
          {[1, 2, 3].map((i) => (
            <div key={i} className={styles.operationSkeleton}>
              <div className={styles.skeletonBar} style={{ width: '100%' }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.operationsHistory} data-testid="operations-error">
        <div className={styles.operationsHeader}>
          <h3>Recent Operations</h3>
        </div>
        <div className={styles.operationsEmpty}>
          <span className={styles.errorIcon}>⚠️</span>
          <p>Failed to load operations</p>
          <p className={styles.operationsHint}>{error.message}</p>
        </div>
      </div>
    );
  }

  if (formattedOps.length === 0) {
    return (
      <div className={styles.operationsHistory} data-testid="operations-empty">
        <div className={styles.operationsHeader}>
          <h3>Recent Operations</h3>
        </div>
        <div className={styles.operationsEmpty}>
          <span>📭</span>
          <p>No operations found</p>
          <p className={styles.operationsHint}>
            This account hasn't performed any operations yet
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.operationsHistory} data-testid="operations-content">
      <div className={styles.operationsHeader}>
        <h3>Recent Operations</h3>
        <a
          href={`https://stellar.expert/explorer/${
            accountId?.length === 56 ? 'testnet' : 'public'
          }/account/${accountId}`}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.operationsLink}
          title="View all operations on stellar.expert"
        >
          View all →
        </a>
      </div>

      <div className={styles.operationsList}>
        {formattedOps.map((op) => (
          <a
            key={op.id}
            href={op.link}
            target="_blank"
            rel="noopener noreferrer"
            className={`${styles.operationItem} ${styles[`status-${op.status}`]}`}
            data-testid={`operation-${op.id}`}
          >
            <div className={styles.operationIcon}>
              {getOperationIcon(op.type)}
            </div>

            <div className={styles.operationInfo}>
              <div className={styles.operationType}>
                {OPERATION_TYPE_LABELS[op.type] || op.type}
              </div>
              <div className={styles.operationTime}>
                {formatTime(op.timestamp.toISOString())}
              </div>
            </div>

            {op.amount && (
              <div className={styles.operationAmount}>
                {op.amount} {op.asset}
              </div>
            )}

            <div className={styles.operationStatus}>
              {op.status === 'success' ? '✓' : '✗'}
            </div>
          </a>
        ))}
      </div>

      {formattedOps.length >= limit && onLoadMore && (
        <button
          onClick={onLoadMore}
          className={styles.operationsLoadMore}
          title="Load more operations"
        >
          Load More Operations
        </button>
      )}
    </div>
  );
};

OperationsHistory.displayName = 'OperationsHistory';
