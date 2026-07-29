# Stellar Account Viewer - Quick Start

## 30-Second Setup

```tsx
import { StellarAccountViewer } from '@/dashboard/stellar';

export function MyPage() {
  return (
    <StellarAccountViewer
      accountId="GBRPYHIL2CI3CXUASAJXLY242ZLBXNBEJRVW3RRVQPLQHPD4UO5W7FXE"
    />
  );
}
```

That's it! The component handles everything:
- ✅ Fetches account data from Horizon API
- ✅ Displays balance with USD conversion
- ✅ Shows recent operations
- ✅ Auto-refreshes every 30 seconds
- ✅ Handles unfunded accounts gracefully
- ✅ Responsive mobile/desktop design

## Common Tasks

### Show Only Balance
```tsx
<StellarAccountViewer
  accountId="G..."
  showOperations={false}
/>
```

### Manual Refresh Button Only
```tsx
<StellarAccountViewer
  accountId="G..."
  autoRefresh={false}  // Disable auto-refresh
/>
```

### Custom Network
```tsx
<StellarAccountViewer
  accountId="G..."
  network="mainnet"  // Instead of "testnet"
/>
```

### Handle Errors
```tsx
<StellarAccountViewer
  accountId="G..."
  onError={(error) => console.error(error)}
  onAccountLoaded={(account) => console.log(account)}
/>
```

### Use the Hook Directly
```tsx
import { useStellarAccount } from '@/dashboard/stellar';

export function MyComponent() {
  const { account, xlmBalance, operations, isLoading, refetch } = useStellarAccount({
    accountId: 'G...',
  });

  if (isLoading) return <div>Loading...</div>;
  
  return (
    <div>
      <h1>Balance: {xlmBalance} XLM</h1>
      <button onClick={refetch}>Refresh</button>
    </div>
  );
}
```

## Props Quick Reference

| Prop | Type | Default | Example |
|------|------|---------|---------|
| `accountId` | string | **Required** | `"GBRP..."` |
| `autoRefresh` | boolean | `true` | `false` |
| `autoRefreshInterval` | number | `30000` | `60000` |
| `showOperations` | boolean | `true` | `false` |
| `operationLimit` | number | `10` | `5` |
| `network` | string | `'testnet'` | `'mainnet'` |
| `onError` | function | - | `(err) => {}` |
| `onAccountLoaded` | function | - | `(acc) => {}` |

## Hook API Quick Reference

```tsx
const {
  // Data
  account,           // Full account object
  xlmBalance,        // Balance as string
  operations,        // Array of operations
  
  // States
  isLoading,         // Initial load
  isFetching,        // Refreshing
  error,             // Error object or null
  isUnfunded,        // Account not found
  
  // Actions
  refetch,           // Refresh everything
  refreshAccount,    // Refresh balance only
  refreshOperations, // Refresh operations only
  reset,             // Reset to initial state
} = useStellarAccount({ accountId: 'G...' });
```

## Error States Handled

✅ **Unfunded Account** (404)
- Shows: "Account Not Yet Created"
- Action: Display funding address

✅ **Network Error**
- Shows: "Failed to Load Account"
- Action: Retry button available

✅ **Invalid Account ID**
- Shows: Error message
- Action: Check address format

✅ **Rate Limited**
- Shows: "Horizon API rate limit exceeded"
- Action: Increase refresh interval

## File Locations

```
src/dashboard/stellar/
├── StellarAccountViewer.tsx      # Main component
├── BalanceDisplay.tsx             # Balance subcomponent
├── OperationsHistory.tsx          # Operations subcomponent
├── AccountFlags.tsx               # Flags subcomponent
├── useStellarAccount.ts           # Data fetching hook
├── types.ts                       # TypeScript types
├── StellarAccountViewer.module.css # Styles
├── index.ts                       # Exports
├── README.md                      # Full documentation
├── INTEGRATION_CHECKLIST.md       # Integration guide
├── IMPLEMENTATION_SUMMARY.md      # Architecture details
└── __tests__/                     # Test suite
```

## Test Accounts

**Testnet (for development):**
```
GBRPYHIL2CI3CXUASAJXLY242ZLBXNBEJRVW3RRVQPLQHPD4UO5W7FXE  # Funded
GBZY3Y3LQ5AH3FAPIPYMIQZXGBLWF3H6ZRPZ3KFBKOKXKZPK7FBE4RHH  # Unfunded
```

**Mainnet (for production):**
```
Use real accounts or test with known public addresses
```

## Styling

The component uses CSS variables. Customize colors in your app:

```css
:root {
  --color-primary: #007bff;
  --color-background: #ffffff;
  --color-text-primary: #1a1a1a;
  /* ... more variables ... */
}
```

Dark mode works automatically with `prefers-color-scheme: dark`

## Performance Tips

1. **For lists of accounts**, memoize:
   ```tsx
   const MemoizedViewer = React.memo(StellarAccountViewer);
   ```

2. **For reduced API calls**, increase interval:
   ```tsx
   <StellarAccountViewer autoRefreshInterval={60000} />  // 60s instead of 30s
   ```

3. **For faster initial render**, show less:
   ```tsx
   <StellarAccountViewer showOperations={false} operationLimit={5} />
   ```

## Accessibility

✅ Full WCAG 2.1 AA compliance
- Keyboard navigation
- Screen reader support
- High contrast
- Proper heading hierarchy

## Testing

```bash
# Run tests
npm test -- src/dashboard/stellar/

# With coverage
npm test -- src/dashboard/stellar/ --coverage

# Watch mode
npm test -- src/dashboard/stellar/ --watch
```

## Common Patterns

### Pattern 1: Linked Account in Dashboard
```tsx
function Dashboard() {
  const user = useAuth();
  return user.stellarAddress ? (
    <StellarAccountViewer accountId={user.stellarAddress} />
  ) : (
    <div>Link a Stellar account first</div>
  );
}
```

### Pattern 2: Account Lookup
```tsx
function AccountLookup() {
  const [address, setAddress] = useState('');
  return (
    <>
      <input
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder="GBRP..."
      />
      {address && <StellarAccountViewer accountId={address} />}
    </>
  );
}
```

### Pattern 3: Account Monitor
```tsx
function Monitor() {
  return (
    <div className="grid">
      {accounts.map(addr => (
        <StellarAccountViewer key={addr} accountId={addr} />
      ))}
    </div>
  );
}
```

## Troubleshooting

**Q: "Account not found" error**
A: Make sure you're using the right network (testnet vs mainnet)

**Q: Component not updating**
A: Check that `autoRefreshInterval > 0` (default is 30000ms)

**Q: Rate limit errors**
A: Increase refresh interval: `autoRefreshInterval={60000}`

**Q: Component won't mount**
A: Verify `accountId` is a valid 56-character public key starting with 'G'

## Next Steps

1. ✅ Import and use the component
2. 📖 Read the [full README](./README.md) for advanced features
3. 🔧 Check [integration examples](./INTEGRATION_EXAMPLES.tsx) for patterns
4. ✓ Run [tests](./src/dashboard/stellar/__tests__/StellarAccountViewer.test.tsx)
5. 📋 Follow [integration checklist](./INTEGRATION_CHECKLIST.md) before production

---

**Need help?** Check README.md or INTEGRATION_EXAMPLES.tsx for more details.
