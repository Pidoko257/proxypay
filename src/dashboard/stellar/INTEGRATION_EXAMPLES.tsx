/**
 * Stellar Account Viewer - Integration Examples
 * Demonstrates different ways to integrate the component
 */

import React, { useState } from 'react';
import {
  StellarAccountViewer,
  useStellarAccount,
  type StellarAccount,
  type StellarAccountError,
} from './index';

// ============================================================================
// Example 1: Basic Integration
// ============================================================================

export function BasicIntegration() {
  return (
    <div>
      <h1>Stellar Account</h1>
      <StellarAccountViewer
        accountId="GBRPYHIL2CI3CXUASAJXLY242ZLBXNBEJRVW3RRVQPLQHPD4UO5W7FXE"
        autoRefresh={true}
        autoRefreshInterval={30000}
      />
    </div>
  );
}

// ============================================================================
// Example 2: With Error Handling and Callbacks
// ============================================================================

export function IntegrationWithCallbacks() {
  const [account, setAccount] = useState<StellarAccount | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [notification, setNotification] = useState<string>('');

  const handleError = (err: Error) => {
    setError(err);
    setNotification(`Error: ${err.message}`);
    setTimeout(() => setNotification(''), 5000);
  };

  const handleAccountLoaded = (loadedAccount: StellarAccount) => {
    setAccount(loadedAccount);
    setNotification('✓ Account loaded successfully');
    setTimeout(() => setNotification(''), 3000);
  };

  return (
    <div>
      <h1>Developer Dashboard</h1>

      {/* Notification Toast */}
      {notification && (
        <div className="notification">
          {notification}
        </div>
      )}

      {/* Error Alert */}
      {error && (
        <div className="alert alert-error">
          <strong>Error:</strong> {error.message}
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {/* Account Info */}
      {account && (
        <div className="account-info">
          <p>
            <strong>Sequence:</strong> {account.sequence}
          </p>
          <p>
            <strong>Subentries:</strong> {account.subentry_count}
          </p>
        </div>
      )}

      {/* Account Viewer */}
      <StellarAccountViewer
        accountId="GBRPYHIL2CI3CXUASAJXLY242ZLBXNBEJRVW3RRVQPLQHPD4UO5W7FXE"
        network="testnet"
        onError={handleError}
        onAccountLoaded={handleAccountLoaded}
      />
    </div>
  );
}

// ============================================================================
// Example 3: Using the Hook Directly
// ============================================================================

export function HookDirectIntegration() {
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
  } = useStellarAccount({
    accountId: 'GBRPYHIL2CI3CXUASAJXLY242ZLBXNBEJRVW3RRVQPLQHPD4UO5W7FXE',
    autoRefreshInterval: 30000,
    operationLimit: 10,
  });

  if (isLoading) {
    return <div>Loading account...</div>;
  }

  if (error && !isUnfunded) {
    return (
      <div>
        <p>Error: {error.message}</p>
        <button onClick={refetch}>Try Again</button>
      </div>
    );
  }

  if (isUnfunded) {
    return (
      <div>
        <p>Account not yet funded. Send XLM to activate.</p>
      </div>
    );
  }

  return (
    <div>
      <h2>Account Balance</h2>
      <p className="balance">{xlmBalance} XLM</p>

      <h2>Account Info</h2>
      <ul>
        <li>Sequence: {account?.sequence}</li>
        <li>Signers: {account?.signers.length}</li>
        <li>Subentries: {account?.subentry_count}</li>
      </ul>

      <h2>Recent Operations</h2>
      <ul>
        {operations.map((op) => (
          <li key={op.id}>
            {op.type} - {op.created_at}
          </li>
        ))}
      </ul>

      <button onClick={refetch} disabled={isFetching}>
        {isFetching ? 'Refreshing...' : 'Refresh'}
      </button>
    </div>
  );
}

// ============================================================================
// Example 4: Multi-Account Dashboard
// ============================================================================

export function MultiAccountDashboard() {
  const [accounts, setAccounts] = useState<string[]>([
    'GBRPYHIL2CI3CXUASAJXLY242ZLBXNBEJRVW3RRVQPLQHPD4UO5W7FXE',
    'GDZST3XVCDTUJ76ZAV2HA72KYGS4YLVQ43D2L3RBTSX3OXA3B2I7DCPM',
  ]);
  const [selectedAccount, setSelectedAccount] = useState(accounts[0]);

  return (
    <div>
      <h1>Multi-Account Dashboard</h1>

      {/* Account Selector */}
      <div className="account-selector">
        <label>Select Account:</label>
        <select
          value={selectedAccount}
          onChange={(e) => setSelectedAccount(e.target.value)}
        >
          {accounts.map((account) => (
            <option key={account} value={account}>
              {account.slice(0, 8)}...{account.slice(-8)}
            </option>
          ))}
        </select>
      </div>

      {/* Account Viewer */}
      <key={selectedAccount}
      <StellarAccountViewer
        key={selectedAccount}
        accountId={selectedAccount}
        autoRefresh={true}
        operationLimit={5}
      />
    </div>
  );
}

// ============================================================================
// Example 5: Network Selector
// ============================================================================

export function NetworkSelectorIntegration() {
  const [network, setNetwork] = useState<'testnet' | 'mainnet'>('testnet');
  const [accountId, setAccountId] = useState<string>('');

  const testnetAddress = 'GBRPYHIL2CI3CXUASAJXLY242ZLBXNBEJRVW3RRVQPLQHPD4UO5W7FXE';
  const mainnetAddress = 'GDZST3XVCDTUJ76ZAV2HA72KYGS4YLVQ43D2L3RBTSX3OXA3B2I7DCPM';

  const currentAddress = network === 'testnet' ? testnetAddress : mainnetAddress;

  return (
    <div>
      <h1>Network Selector</h1>

      <div className="network-selector">
        <label>
          <input
            type="radio"
            value="testnet"
            checked={network === 'testnet'}
            onChange={(e) => {
              setNetwork('testnet');
              setAccountId('');
            }}
          />
          Testnet
        </label>
        <label>
          <input
            type="radio"
            value="mainnet"
            checked={network === 'mainnet'}
            onChange={(e) => {
              setNetwork('mainnet');
              setAccountId('');
            }}
          />
          Mainnet
        </label>
      </div>

      <p className="info">
        Current Network: <strong>{network.toUpperCase()}</strong>
      </p>

      {/* Account Viewer */}
      <StellarAccountViewer
        key={`${network}-${currentAddress}`}
        accountId={currentAddress}
        network={network}
      />
    </div>
  );
}

// ============================================================================
// Example 6: Embedded in a Card
// ============================================================================

export function CardIntegration() {
  return (
    <div className="card">
      <div className="card-header">
        <h2>Linked Stellar Account</h2>
      </div>
      <div className="card-body">
        <StellarAccountViewer
          accountId="GBRPYHIL2CI3CXUASAJXLY242ZLBXNBEJRVW3RRVQPLQHPD4UO5W7FXE"
          autoRefreshInterval={60000}
          operationLimit={5}
        />
      </div>
    </div>
  );
}

// ============================================================================
// Example 7: With Manual Account Input
// ============================================================================

export function ManualAccountInput() {
  const [inputValue, setInputValue] = useState('');
  const [selectedAccount, setSelectedAccount] = useState('');
  const [inputError, setInputError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Validate Stellar address
    if (!inputValue.startsWith('G') || inputValue.length !== 56) {
      setInputError('Invalid Stellar address. Must start with G and be 56 characters.');
      return;
    }

    setSelectedAccount(inputValue);
    setInputValue('');
    setInputError('');
  };

  return (
    <div>
      <h1>Account Viewer</h1>

      {/* Input Form */}
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="stellar-address">Stellar Address:</label>
          <input
            id="stellar-address"
            type="text"
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              setInputError('');
            }}
            placeholder="GBRPYHIL2CI3..."
          />
          {inputError && <p className="error">{inputError}</p>}
        </div>
        <button type="submit">Load Account</button>
      </form>

      {/* Account Viewer */}
      {selectedAccount && (
        <StellarAccountViewer
          key={selectedAccount}
          accountId={selectedAccount}
          autoRefresh={true}
        />
      )}
    </div>
  );
}

// ============================================================================
// Example 8: With Loading Skeleton
// ============================================================================

export function LoadingSkeletonExample() {
  const [account, setAccount] = useState<StellarAccount | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  return (
    <div>
      <h1>Account Dashboard</h1>

      {isLoading && <div className="skeleton-loader">Loading...</div>}

      <StellarAccountViewer
        accountId="GBRPYHIL2CI3CXUASAJXLY242ZLBXNBEJRVW3RRVQPLQHPD4UO5W7FXE"
        autoRefresh={true}
        onAccountLoaded={(loadedAccount) => {
          setAccount(loadedAccount);
          setIsLoading(false);
        }}
      />

      {account && (
        <div className="account-summary">
          <h2>Account Summary</h2>
          <p>Sequence: {account.sequence}</p>
          <p>Last Modified: {new Date(account.last_modified_time).toLocaleString()}</p>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Example 9: Responsive Mobile Layout
// ============================================================================

export function ResponsiveLayout() {
  return (
    <div className="mobile-layout">
      <header className="header">
        <h1>My Stellar Account</h1>
      </header>

      <main className="main">
        <StellarAccountViewer
          accountId="GBRPYHIL2CI3CXUASAJXLY242ZLBXNBEJRVW3RRVQPLQHPD4UO5W7FXE"
          autoRefresh={true}
          className="full-width"
        />
      </main>

      <footer className="footer">
        <p>Powered by Stellar Network</p>
      </footer>
    </div>
  );
}

// ============================================================================
// Example 10: Complete Developer Dashboard
// ============================================================================

export function CompleteDeveloperDashboard() {
  const [userAccount, setUserAccount] = useState<StellarAccount | null>(null);
  const [dashboardError, setDashboardError] = useState<string>('');

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>ProxyPay Developer Dashboard</h1>
        <nav>
          <a href="/docs">Docs</a>
          <a href="/api">API</a>
          <a href="/settings">Settings</a>
        </nav>
      </header>

      <div className="dashboard-grid">
        {/* Main Content */}
        <main className="dashboard-main">
          <section className="stellar-section">
            <h2>Linked Stellar Account</h2>

            {dashboardError && (
              <div className="alert alert-error">
                {dashboardError}
                <button onClick={() => setDashboardError('')}>Close</button>
              </div>
            )}

            <StellarAccountViewer
              accountId="GBRPYHIL2CI3CXUASAJXLY242ZLBXNBEJRVW3RRVQPLQHPD4UO5W7FXE"
              network="testnet"
              autoRefresh={true}
              autoRefreshInterval={30000}
              showOperations={true}
              operationLimit={10}
              onError={(error) =>
                setDashboardError(`Failed to load account: ${error.message}`)
              }
              onAccountLoaded={(account) => {
                setUserAccount(account);
                setDashboardError('');
              }}
            />
          </section>

          {userAccount && (
            <section className="stats-section">
              <h2>Quick Stats</h2>
              <div className="stats-grid">
                <div className="stat-card">
                  <span className="stat-label">Sequence</span>
                  <span className="stat-value">{userAccount.sequence}</span>
                </div>
                <div className="stat-card">
                  <span className="stat-label">Signers</span>
                  <span className="stat-value">{userAccount.signers.length}</span>
                </div>
                <div className="stat-card">
                  <span className="stat-label">Trustlines</span>
                  <span className="stat-value">{userAccount.subentry_count}</span>
                </div>
              </div>
            </section>
          )}
        </main>

        {/* Sidebar */}
        <aside className="dashboard-sidebar">
          <div className="info-card">
            <h3>Account Status</h3>
            {userAccount ? (
              <p className="status-active">✓ Active</p>
            ) : (
              <p className="status-loading">Loading...</p>
            )}
          </div>

          <div className="info-card">
            <h3>Quick Links</h3>
            <ul>
              <li>
                <a href="/transactions">Transactions</a>
              </li>
              <li>
                <a href="/trustlines">Trustlines</a>
              </li>
              <li>
                <a href="/settings">Settings</a>
              </li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
