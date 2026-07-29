# Stellar Account Viewer

A comprehensive React component for displaying Stellar account information including balances, transaction history, and account flags. Built with TypeScript, client-side data fetching from Stellar Horizon API, and graceful error handling.

## Features

- 🚀 **Real-time Data** — Fetches account data directly from Stellar Horizon API
- 🔄 **Auto-Refresh** — Configurable auto-refresh interval with manual refresh button
- 💰 **Balance Display** — Shows XLM balance with optional USD equivalent
- 📊 **Transaction History** — Recent operations with links to stellar.expert
- 🚩 **Account Flags** — Displays and explains account flags (auth_required, etc.)
- 🛡️ **Error Handling** — Gracefully handles unfunded accounts and network errors
- 🎨 **Responsive Design** — Works on desktop, tablet, and mobile devices
- 🌙 **Dark Mode Support** — Automatic dark mode detection and support
- ♿ **Accessible** — Full WCAG 2.1 AA compliance
- 📦 **TypeScript** — Fully typed with comprehensive type definitions

## Installation

The component is part of the ProxyPay dashboard. Import from `src/dashboard/stellar`:

```typescript
import { StellarAccountViewer } from '@/dashboard/stellar';
```

## Quick Start

### Basic Usage

```tsx
import { StellarAccountViewer } from '@/dashboard/stellar';

export function AccountPage() {
  const userStellarAddress = 'GBRPYHIL2CI3CXUASAJXLY242ZLBXNBEJRVW3RRVQPLQHPD4UO5W7FXE';

  return (
    <StellarAccountViewer
      accountId={userStellarAddress}
      autoRefresh={true}
      autoRefreshInterval={30000}
    />
  );
}
```

### With Error Handling

```tsx
import { StellarAccountViewer } from '@/dashboard/stellar';
import { useState } from 'react';

export function AccountPage() {
  const [error, setError] = useState<Error | null>(null);
  const [account, setAccount] = useState<StellarAccount | null>(null);

  return (
    <>
      {error && <ErrorBanner error={error} />}
      
      <StellarAccountViewer
        accountId="GBRPYHIL2CI3CXUASAJXLY242ZLBXNBEJRVW3RRVQPLQHPD4UO5W7FXE"
        autoRefresh={true}
        onError={setError}
        onAccountLoaded={setAccount}
      />
    </>
  );
}
```

### Custom Network

```tsx
// Use mainnet instead of testnet
<StellarAccountViewer
  accountId="GBRPYHIL2CI3CXUASAJXLY242ZLBXNBEJRVW3RRVQPLQHPD4UO5W7FXE"
  network="mainnet"
/>
```

## Component API

### StellarAccountViewer

Main component that combines all subcomponents.

#### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `accountId` | `string` | **Required** | Stellar public key (starting with 'G', 56 characters) |
| `autoRefresh` | `boolean` | `true` | Enable automatic data refresh |
| `autoRefreshInterval` | `number` | `30000` | Refresh interval in milliseconds |
| `onError` | `(error: Error) => void` | `undefined` | Callback when an error occurs |
| `onAccountLoaded` | `(account: StellarAccount) => void` | `undefined` | Callback when account data is loaded |
| `showOperations` | `boolean` | `true` | Display operations history section |
| `operationLimit` | `number` | `10` | Number of recent operations to display |
| `network` | `'testnet' \| 'mainnet'` | `'testnet'` | Stellar network to use |
| `className` | `string` | `undefined` | CSS class for styling |

#### Example

```tsx
<StellarAccountViewer
  accountId="GBRPYHIL2CI3..."
  autoRefresh={true}
  autoRefreshInterval={30000}
  showOperations={true}
  operationLimit={15}
  network="mainnet"
  onError={(error) => console.error(error)}
  onAccountLoaded={(account) => console.log('Loaded:', account)}
/>
```

### BalanceDisplay

Displays the XLM balance with optional USD equivalent.

#### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `balance` | `string \| null` | `null` | XLM balance as string |
| `isLoading` | `boolean` | `false` | Show loading state |
| `error` | `Error \| null` | `null` | Error to display |
| `xlmPrice` | `number` | `undefined` | XLM price in USD for equivalent calculation |
| `showEquivalent` | `boolean` | `true` | Show USD equivalent |
| `showNative` | `boolean` | `true` | Show native XLM balance |

#### Example

```tsx
<BalanceDisplay
  balance="1000.50"
  isLoading={false}
  error={null}
  xlmPrice={0.35}
  showEquivalent={true}
/>
```

### OperationsHistory

Displays paginated list of recent operations.

#### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `operations` | `Operation[]` | **Required** | Array of operations |
| `isLoading` | `boolean` | `false` | Show loading state |
| `error` | `Error \| null` | `null` | Error to display |
| `accountId` | `string` | **Required** | Account ID for links |
| `limit` | `number` | `10` | Max operations to show |
| `onLoadMore` | `() => Promise<void>` | `undefined` | Callback to load more |

#### Example

```tsx
<OperationsHistory
  operations={operations}
  isLoading={false}
  error={null}
  accountId="GBRPYHIL2CI3..."
  limit={10}
  onLoadMore={() => refreshOperations()}
/>
```

### AccountFlags

Displays account flags with descriptions.

#### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `flags` | `AccountFlags \| null` | `null` | Account flags object |
| `isLoading` | `boolean` | `false` | Show loading state |
| `error` | `Error \| null` | `null` | Error to display |

#### Example

```tsx
<AccountFlags
  flags={{
    auth_required: true,
    auth_revocable: false,
    auth_immutable: false,
    clawback_enabled: false,
  }}
  isLoading={false}
  error={null}
/>
```

## Hook API

### useStellarAccount

Custom React hook for managing Stellar account data fetching and state.

#### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `accountId` | `string` | **Required** | Stellar public key |
| `autoRefreshInterval` | `number` | `30000` | Auto-refresh interval in ms (0 to disable) |
| `operationLimit` | `number` | `10` | Number of operations to fetch |
| `network` | `'testnet' \| 'mainnet'` | `'testnet'` | Stellar network |
| `horizonUrl` | `string` | `auto` | Custom Horizon API URL |
| `debug` | `boolean` | `false` | Enable debug logging |

#### Return Values

| Property | Type | Description |
|----------|------|-------------|
| `account` | `StellarAccount \| null` | Fetched account data |
| `xlmBalance` | `string \| null` | XLM balance amount |
| `operations` | `Operation[]` | Array of recent operations |
| `isLoading` | `boolean` | Initial load state |
| `isFetching` | `boolean` | Current fetch state |
| `error` | `Error \| null` | Current error, if any |
| `lastUpdated` | `Date \| null` | Last update timestamp |
| `isUnfunded` | `boolean` | Account not funded (404) |
| `isFundable` | `boolean` | Account can be funded |
| `refetch()` | `Promise<void>` | Refresh both account and operations |
| `refreshAccount()` | `Promise<void>` | Refresh only account data |
| `refreshOperations()` | `Promise<void>` | Refresh only operations |
| `reset()` | `void` | Reset to initial state |

#### Example

```tsx
import { useStellarAccount } from '@/dashboard/stellar';
import { useEffect } from 'react';

export function MyComponent() {
  const {
    account,
    xlmBalance,
    operations,
    isLoading,
    error,
    isUnfunded,
    refetch,
    refreshAccount,
  } = useStellarAccount({
    accountId: 'GBRPYHIL2CI3...',
    autoRefreshInterval: 30000,
    operationLimit: 10,
    network: 'testnet',
    debug: false,
  });

  // Manual refresh on demand
  const handleManualRefresh = async () => {
    await refetch();
  };

  if (isLoading) return <div>Loading...</div>;
  if (error && !isUnfunded) return <div>Error: {error.message}</div>;
  if (isUnfunded) return <div>Account needs funding</div>;

  return (
    <div>
      <h1>Balance: {xlmBalance} XLM</h1>
      <button onClick={handleManualRefresh}>Refresh</button>
      <ul>
        {operations.map(op => (
          <li key={op.id}>{op.type}</li>
        ))}
      </ul>
    </div>
  );
}
```

## Type Definitions

### StellarAccount

```typescript
interface StellarAccount {
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
```

### Balance

```typescript
interface Balance {
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
```

### AccountFlags

```typescript
interface AccountFlags {
  auth_required: boolean;
  auth_revocable: boolean;
  auth_immutable: boolean;
  clawback_enabled: boolean;
}
```

### Operation

```typescript
interface Operation {
  id: string;
  paging_token: string;
  transaction_hash: string;
  type: OperationType;
  type_i: number;
  created_at: string;
  transaction_successful: boolean;
  source_account: string;
  [key: string]: any; // Additional operation-specific fields
}
```

### StellarAccountError

Error handling enum for different error scenarios:

```typescript
enum StellarAccountError {
  ACCOUNT_NOT_FOUND = 'ACCOUNT_NOT_FOUND',
  NETWORK_ERROR = 'NETWORK_ERROR',
  INVALID_ACCOUNT_ID = 'INVALID_ACCOUNT_ID',
  OPERATIONS_FETCH_FAILED = 'OPERATIONS_FETCH_FAILED',
  TIMEOUT = 'TIMEOUT',
  RATE_LIMITED = 'RATE_LIMITED',
  UNKNOWN = 'UNKNOWN',
}
```

## Error Handling

The component handles various error scenarios gracefully:

### Unfunded Account (404)

When an account address is valid but hasn't been funded yet:

```
🚀 Account Not Yet Created
Send at least 1 XLM to activate it.

[Copy Address Button]
```

### Network Error

When unable to reach Stellar Horizon API:

```
⚠️ Failed to Load Account
Connection timeout while fetching account data
The Stellar network may be temporarily unavailable. Please try again.
```

### Rate Limited

When Horizon API rate limit is exceeded:

```
⚠️ Failed to Load Account
Horizon API rate limit exceeded
```

### Invalid Account ID

When the provided account ID is invalid:

```
⚠️ Failed to Load Account
Invalid Stellar account ID: INVALID123
```

## Styling

### CSS Variables

The component uses CSS variables for theming:

```css
/* Light mode (default) */
--color-background: #ffffff;
--color-background-secondary: #f5f5f5;
--color-border: #e0e0e0;
--color-text-primary: #1a1a1a;
--color-text-secondary: #666;
--color-text-tertiary: #999;
--color-primary: #007bff;
--color-primary-dark: #0056b3;
--color-success: #28a745;
--color-warning: #ffc107;
--color-warning-light: #fff8e1;
--color-danger: #dc3545;
--color-danger-light: #ffe0e0;
--color-info: #17a2b8;
--color-info-light: #e7f3ff;

/* Dark mode */
@media (prefers-color-scheme: dark) {
  --color-background: #1a1a1a;
  --color-background-secondary: #2d2d2d;
  --color-border: #404040;
  --color-text-primary: #e0e0e0;
  --color-text-secondary: #999;
  --color-text-tertiary: #666;
}
```

### Custom Styling

Apply custom styling via className:

```tsx
<StellarAccountViewer
  accountId="GBRPYHIL2CI3..."
  className="custom-viewer"
/>
```

```css
.custom-viewer {
  max-width: 800px;
  margin: 0 auto;
}
```

## Integration with Developer Dashboard

### Adding to Dashboard

1. **Import the component:**

```tsx
import { StellarAccountViewer } from '@/dashboard/stellar';
```

2. **Add to dashboard layout:**

```tsx
export function DeveloperDashboard() {
  const user = useAuth();

  if (!user.stellarAddress) {
    return <div>Link a Stellar account first</div>;
  }

  return (
    <div className="dashboard">
      <header>
        <h1>Developer Dashboard</h1>
      </header>
      
      <section>
        <StellarAccountViewer
          accountId={user.stellarAddress}
          network={process.env.REACT_APP_STELLAR_NETWORK || 'testnet'}
          onError={(error) => toast.error(error.message)}
        />
      </section>
    </div>
  );
}
```

3. **Storing linked account:**

Store the user's linked Stellar account address in your user model:

```typescript
// User model
interface User {
  id: string;
  email: string;
  stellarAddress?: string; // Optional Stellar address
  createdAt: Date;
}
```

## Testing

### Unit Tests

```bash
npm test -- src/dashboard/stellar/__tests__/StellarAccountViewer.test.tsx
```

### Test Coverage

The component includes comprehensive tests for:

- ✅ Loading states
- ✅ Unfunded accounts
- ✅ Funded accounts with balance
- ✅ Operations history
- ✅ Account flags display
- ✅ Error scenarios
- ✅ Refresh functionality
- ✅ Clipboard copying
- ✅ Hook functionality

### Example Test

```typescript
import { render, screen, waitFor } from '@testing-library/react';
import { StellarAccountViewer } from '@/dashboard/stellar';

test('displays balance for funded account', async () => {
  const mockAccountId = 'GBRPYHIL2CI3...';
  
  render(
    <StellarAccountViewer
      accountId={mockAccountId}
      autoRefresh={false}
    />
  );

  await waitFor(() => {
    expect(screen.getByText(/1000.50/)).toBeInTheDocument();
    expect(screen.getByText('XLM')).toBeInTheDocument();
  });
});
```

## Performance Considerations

### Data Fetching

- **Lazy loading:** Operations are fetched only if `showOperations={true}`
- **Pagination:** Operations limited to 10 by default to reduce payload
- **Debouncing:** Auto-refresh can be tuned via `autoRefreshInterval`

### Optimization Tips

```tsx
// 1. Memoize the component
const MemoizedViewer = React.memo(StellarAccountViewer);

// 2. Disable auto-refresh if not needed
<StellarAccountViewer accountId="..." autoRefresh={false} />

// 3. Increase refresh interval for less frequent updates
<StellarAccountViewer 
  accountId="..." 
  autoRefreshInterval={60000} // 60 seconds
/>

// 4. Limit operations display
<StellarAccountViewer 
  accountId="..." 
  showOperations={true}
  operationLimit={5} // Show only 5 operations
/>
```

## Accessibility

- ✅ ARIA labels on all interactive elements
- ✅ Keyboard navigation support
- ✅ High contrast colors for readability
- ✅ Semantic HTML structure
- ✅ Error announcements for screen readers
- ✅ Skip links for navigation

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Mobile Safari 14+

## Common Issues

### Issue: "Account not found" for valid address

**Solution:** Check that you're using the correct Stellar network:

```tsx
// Use testnet for testnet addresses
<StellarAccountViewer
  accountId="GBZY..." // testnet address
  network="testnet"
/>

// Use mainnet for mainnet addresses
<StellarAccountViewer
  accountId="GBRP..." // mainnet address
  network="mainnet"
/>
```

### Issue: Auto-refresh not updating

**Solution:** Check the auto-refresh interval setting:

```tsx
// This disables auto-refresh (0 means no refresh)
<StellarAccountViewer accountId="..." autoRefreshInterval={0} />

// This enables refresh every 30 seconds
<StellarAccountViewer accountId="..." autoRefreshInterval={30000} />
```

### Issue: Rate limit errors

**Solution:** Increase the auto-refresh interval:

```tsx
// Instead of 5s intervals, use 30s
<StellarAccountViewer 
  accountId="..." 
  autoRefreshInterval={30000} // 30 seconds instead of 5
/>
```

## API Reference

For more details on Stellar API responses:

- [Stellar Horizon API Docs](https://developers.stellar.org/api/introduction/index/)
- [Account Resource](https://developers.stellar.org/api/resources/accounts/)
- [Operations Resource](https://developers.stellar.org/api/resources/operations/)

## Contributing

To contribute improvements:

1. Make changes to files in `src/dashboard/stellar/`
2. Add/update tests in `src/dashboard/stellar/__tests__/`
3. Update this README if adding new features
4. Run tests: `npm test`
5. Submit a pull request

## License

MIT - Part of the ProxyPay project
