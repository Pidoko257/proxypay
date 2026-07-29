import React, { useMemo } from 'react';
import { BalanceDisplayProps } from './types';
import styles from './StellarAccountViewer.module.css';

/**
 * Formats a balance string to a readable number with proper decimal places
 */
function formatBalance(balance: string | null): string {
  if (!balance) return '0.00';

  try {
    const num = parseFloat(balance);
    if (isNaN(num)) return '0.00';
    
    // Format with 2-7 decimal places depending on value
    if (num === 0) return '0.00';
    if (num < 0.0001) return num.toExponential(2);
    if (num < 1) return num.toFixed(7).replace(/0+$/, '');
    
    return num.toFixed(2);
  } catch {
    return '0.00';
  }
}

/**
 * Calculates USD equivalent of XLM balance
 */
function calculateEquivalent(balance: string | null, xlmPrice: number | undefined): string {
  if (!balance || !xlmPrice) return '$0.00';

  try {
    const num = parseFloat(balance);
    const usd = num * xlmPrice;
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(usd);
  } catch {
    return '$0.00';
  }
}

/**
 * BalanceDisplay Component
 * 
 * Displays the XLM balance of a Stellar account with optional USD equivalent
 * Handles loading and error states gracefully
 * 
 * @example
 * <BalanceDisplay
 *   balance="1000.50"
 *   isLoading={false}
 *   error={null}
 *   xlmPrice={0.35}
 *   showEquivalent={true}
 * />
 */
export const BalanceDisplay: React.FC<BalanceDisplayProps> = ({
  balance,
  isLoading,
  error,
  xlmPrice,
  showEquivalent = true,
  showNative = true,
}) => {
  const formattedBalance = useMemo(
    () => formatBalance(balance),
    [balance],
  );

  const equivalentAmount = useMemo(
    () => calculateEquivalent(balance, xlmPrice),
    [balance, xlmPrice],
  );

  if (isLoading) {
    return (
      <div className={styles.balanceDisplay} data-testid="balance-loading">
        <div className={styles.balanceContent}>
          <div className={styles.balanceLabel}>XLM Balance</div>
          <div className={styles.balanceSkeleton}>
            <div className={styles.skeletonBar} />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.balanceDisplay} data-testid="balance-error">
        <div className={styles.balanceContent}>
          <div className={styles.balanceLabel}>XLM Balance</div>
          <div className={styles.balanceError}>
            <span className={styles.errorIcon}>⚠️</span>
            Failed to load balance
          </div>
          <div className={styles.balanceHint}>
            {error.message || 'Please try again later'}
          </div>
        </div>
      </div>
    );
  }

  const displayBalance = showNative ? formattedBalance : '0.00';
  const showEquiv = showEquivalent && xlmPrice;

  return (
    <div className={styles.balanceDisplay} data-testid="balance-content">
      <div className={styles.balanceContent}>
        <div className={styles.balanceLabel}>XLM Balance</div>
        
        <div className={styles.balanceAmount}>
          <span className={styles.balanceCurrency}>Ⓛ</span>
          <span className={styles.balanceValue}>{displayBalance}</span>
          <span className={styles.balanceUnit}>XLM</span>
        </div>

        {showEquiv && (
          <div className={styles.balanceEquivalent}>
            ≈ {equivalentAmount}
            {xlmPrice && (
              <span className={styles.balancePriceHint}>
                @ ${xlmPrice.toFixed(4)}/XLM
              </span>
            )}
          </div>
        )}

        {displayBalance === '0.00' && (
          <div className={styles.balanceHint}>
            Account is unfunded. Send XLM to activate.
          </div>
        )}
      </div>

      {/* Visual balance indicator */}
      <div className={styles.balanceIndicator}>
        <div
          className={styles.balanceFill}
          style={{
            width: `${Math.min(
              (parseFloat(displayBalance) / 1000) * 100,
              100,
            )}%`,
          }}
        />
      </div>
    </div>
  );
};

BalanceDisplay.displayName = 'BalanceDisplay';
