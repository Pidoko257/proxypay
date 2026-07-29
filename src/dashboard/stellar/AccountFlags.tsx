import React from 'react';
import { AccountFlagsProps } from './types';
import styles from './StellarAccountViewer.module.css';

/**
 * Flag descriptions for user reference
 */
const FLAG_DESCRIPTIONS: Record<string, string> = {
  auth_required:
    'Requires authorization before accepting funds. Issuer must explicitly allow accounts to hold this asset.',
  auth_revocable:
    'Allows issuer to revoke trust relationship. Can be disabled but not re-enabled.',
  auth_immutable:
    'Locks the account in its current state. All other flags become permanent.',
  clawback_enabled:
    'Allows issuer to claw back (remove) a balance from the account.',
};

/**
 * Flag UI metadata
 */
const FLAG_METADATA: Record<
  string,
  { icon: string; label: string; severity: 'info' | 'warning' | 'danger' }
> = {
  auth_required: {
    icon: '🔐',
    label: 'Authorization Required',
    severity: 'info',
  },
  auth_revocable: {
    icon: '🔄',
    label: 'Revocable',
    severity: 'warning',
  },
  auth_immutable: {
    icon: '🔒',
    label: 'Immutable',
    severity: 'danger',
  },
  clawback_enabled: {
    icon: '🔙',
    label: 'Clawback Enabled',
    severity: 'warning',
  },
};

/**
 * AccountFlags Component
 *
 * Displays the flags set on a Stellar account (auth_required, auth_revocable, etc.)
 * Shows human-readable descriptions and visual indicators for each flag
 *
 * @example
 * <AccountFlags
 *   flags={{
 *     auth_required: true,
 *     auth_revocable: false,
 *     auth_immutable: false,
 *     clawback_enabled: false,
 *   }}
 *   isLoading={false}
 *   error={null}
 * />
 */
export const AccountFlags: React.FC<AccountFlagsProps> = ({
  flags,
  isLoading,
  error,
}) => {
  if (isLoading) {
    return (
      <div className={styles.accountFlags} data-testid="flags-loading">
        <div className={styles.flagsHeader}>
          <h3>Account Flags</h3>
        </div>
        <div className={styles.flagsContent}>
          {[1, 2].map((i) => (
            <div key={i} className={styles.flagSkeleton}>
              <div className={styles.skeletonBar} style={{ width: '80%' }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.accountFlags} data-testid="flags-error">
        <div className={styles.flagsHeader}>
          <h3>Account Flags</h3>
        </div>
        <div className={styles.flagsEmpty}>
          <span className={styles.errorIcon}>⚠️</span>
          <p>Failed to load account flags</p>
          <p className={styles.flagsHint}>{error.message}</p>
        </div>
      </div>
    );
  }

  if (!flags) {
    return (
      <div className={styles.accountFlags} data-testid="flags-empty">
        <div className={styles.flagsHeader}>
          <h3>Account Flags</h3>
        </div>
        <div className={styles.flagsEmpty}>
          <p>No flag information available</p>
        </div>
      </div>
    );
  }

  // Get enabled flags
  const enabledFlags = Object.entries(flags)
    .filter(([, value]) => value === true)
    .map(([key]) => key as keyof typeof flags);

  const allFlags = Object.keys(flags) as Array<keyof typeof flags>;

  return (
    <div className={styles.accountFlags} data-testid="flags-content">
      <div className={styles.flagsHeader}>
        <h3>Account Flags</h3>
        <span className={styles.flagsCount}>
          {enabledFlags.length} of {allFlags.length}
        </span>
      </div>

      <div className={styles.flagsContent}>
        {allFlags.map((flagKey) => {
          const isEnabled = flags[flagKey];
          const metadata = FLAG_METADATA[flagKey];
          const description = FLAG_DESCRIPTIONS[flagKey];

          if (!metadata) return null;

          return (
            <div
              key={flagKey}
              className={`${styles.flagItem} ${styles[`severity-${metadata.severity}`]} ${
                isEnabled ? styles.flagEnabled : styles.flagDisabled
              }`}
              data-testid={`flag-${flagKey}`}
              title={description}
            >
              <div className={styles.flagIcon}>{metadata.icon}</div>
              <div className={styles.flagContent}>
                <div className={styles.flagLabel}>{metadata.label}</div>
                <div className={styles.flagDescription}>{description}</div>
              </div>
              <div className={styles.flagStatus}>
                {isEnabled ? (
                  <span className={styles.flagBadgeEnabled}>✓ Enabled</span>
                ) : (
                  <span className={styles.flagBadgeDisabled}>○ Disabled</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {enabledFlags.length === 0 && (
        <div className={styles.flagsHint}>
          <p>
            This account has no special flags enabled. All operations are unrestricted.
          </p>
        </div>
      )}

      {enabledFlags.length > 0 && (
        <div className={styles.flagsWarning}>
          <p>
            <strong>⚠️ Note:</strong> This account has{' '}
            {enabledFlags.length === 1 ? 'a flag' : `${enabledFlags.length} flags`} enabled that may
            restrict operations or asset transfers.
          </p>
        </div>
      )}
    </div>
  );
};

AccountFlags.displayName = 'AccountFlags';
