# Stellar Account Viewer - Integration Checklist

## Pre-Integration Checklist

- [ ] Review README.md for features and requirements
- [ ] Check browser compatibility requirements
- [ ] Verify stellar-sdk is installed: `npm list stellar-sdk`
- [ ] Ensure React 17+ and TypeScript are available
- [ ] Review WCAG 2.1 AA accessibility requirements

## Basic Integration Steps

### 1. Import Component
```tsx
import { StellarAccountViewer } from '@/dashboard/stellar';
// or individual imports:
import { BalanceDisplay, OperationsHistory, AccountFlags } from '@/dashboard/stellar';
```

### 2. Add to Dashboard
```tsx
export function DeveloperDashboard() {
  const userAccount = useAuth().stellarAddress;
  
  return (
    <StellarAccountViewer
      accountId={userAccount}
      autoRefresh={true}
    />
  );
}
```

### 3. Store User's Stellar Address
In your User model, add optional field:
```typescript
interface User {
  id: string;
  email: string;
  stellarAddress?: string; // Add this field
}
```

### 4. Create Account Linking Flow
```tsx
function LinkStellarAccountModal() {
  const [address, setAddress] = useState('');
  
  const handleLink = async () => {
    await updateUserStellarAddress(address);
  };
  
  return (
    <Dialog>
      <input
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder="GBRPYHIL2CI3..."
      />
      <button onClick={handleLink}>Link Account</button>
    </Dialog>
  );
}
```

## Advanced Integration

### Error Handling
- [ ] Add error boundary wrapper
- [ ] Implement toast notifications for errors
- [ ] Create error recovery UI
- [ ] Log errors to monitoring service

```tsx
<ErrorBoundary>
  <StellarAccountViewer
    accountId={userAccount}
    onError={(error) => {
      logToSentry(error);
      showToast(`Error: ${error.message}`, 'error');
    }}
  />
</ErrorBoundary>
```

### Performance
- [ ] Memoize component if in list: `React.memo(StellarAccountViewer)`
- [ ] Configure appropriate refresh interval (30-60s recommended)
- [ ] Set operation limit based on UI space (5-15 recommended)
- [ ] Monitor bundle size impact

```tsx
<StellarAccountViewer
  accountId={userAccount}
  autoRefreshInterval={30000}  // 30 seconds
  operationLimit={10}          // 10 operations
/>
```

### Theming
- [ ] Define CSS color variables in your app root:

```css
:root {
  --color-background: #ffffff;
  --color-background-secondary: #f5f5f5;
  --color-border: #e0e0e0;
  --color-text-primary: #1a1a1a;
  --color-text-secondary: #666;
  --color-primary: #007bff;
  /* ... other colors ... */
}

@media (prefers-color-scheme: dark) {
  :root {
    --color-background: #1a1a1a;
    /* ... dark colors ... */
  }
}
```

### Analytics
- [ ] Track account views
- [ ] Log refresh button clicks
- [ ] Monitor error rates
- [ ] Track component render times

```tsx
<StellarAccountViewer
  accountId={userAccount}
  onAccountLoaded={(account) => {
    analytics.track('stellar_account_loaded', {
      accountId: account.id,
      balance: account.balances[0].balance,
    });
  }}
/>
```

## Testing

### Unit Tests
```bash
npm test -- src/dashboard/stellar/__tests__/
```

### Manual Testing Checklist
- [ ] Load component with valid testnet account
- [ ] Load component with valid mainnet account
- [ ] Test with unfunded account
- [ ] Test with invalid account ID
- [ ] Test refresh button functionality
- [ ] Test copy-to-clipboard button
- [ ] Test on mobile/tablet viewport
- [ ] Test dark mode
- [ ] Test with network disconnected
- [ ] Test with slow network (3G throttle)

### Accounts for Testing

**Testnet:**
- GBRPYHIL2CI3CXUASAJXLY242ZLBXNBEJRVW3RRVQPLQHPD4UO5W7FXE (funded)
- GBZY3Y3LQ5AH3FAPIPYMIQZXGBLWF3H6ZRPZ3KFBKOKXKZPK7FBE4RHH (unfunded)

**Mainnet:**
- GDZST3XVCDTUJ76ZAV2HA72KYGS4YLVQ43D2L3RBTSX3OXA3B2I7DCPM (funded)

## Network Configuration

### Environment Variables
```bash
# .env.local or .env.{environment}
REACT_APP_STELLAR_NETWORK=testnet
# or
REACT_APP_STELLAR_NETWORK=mainnet
```

### Using Environment Variable
```tsx
<StellarAccountViewer
  accountId={userAccount}
  network={
    (process.env.REACT_APP_STELLAR_NETWORK as 'testnet' | 'mainnet') ||
    'testnet'
  }
/>
```

## Deployment Checklist

### Pre-Deployment
- [ ] All tests passing: `npm test`
- [ ] No TypeScript errors: `npx tsc --noEmit`
- [ ] No console errors: check browser console
- [ ] Mobile tested on real device
- [ ] Accessibility checked with axe DevTools
- [ ] Performance check with Lighthouse

### Production
- [ ] Use mainnet configuration for production
- [ ] Verify Horizon API is accessible
- [ ] Monitor error rates
- [ ] Set up alerting for component errors
- [ ] Document support page for unfunded accounts

### Post-Deployment
- [ ] Monitor error logs for first 24h
- [ ] Check performance metrics
- [ ] Verify refresh intervals are appropriate
- [ ] Collect user feedback
- [ ] Document any issues

## Troubleshooting

### Issue: "Account not found" for valid address
**Solution**: Verify using correct network (testnet vs mainnet)
```tsx
// Check account on correct network
const account = 'GBRPY...'; // testnet address
<StellarAccountViewer accountId={account} network="testnet" />
```

### Issue: Auto-refresh not updating
**Solution**: Check interval is > 0
```tsx
// This disables refresh (0 = disabled)
<StellarAccountViewer accountId="..." autoRefreshInterval={0} />

// This enables 30s refresh
<StellarAccountViewer accountId="..." autoRefreshInterval={30000} />
```

### Issue: Rate limit errors
**Solution**: Increase refresh interval
```tsx
// Reduce from 5s to 30s intervals
<StellarAccountViewer 
  accountId="..." 
  autoRefreshInterval={30000}
/>
```

### Issue: Component not rendering
**Solution**: Check Stellar address is provided and valid
```tsx
if (!userAccount) {
  return <div>Link a Stellar account first</div>;
}

<StellarAccountViewer accountId={userAccount} />
```

## Support Resources

- [Stellar Documentation](https://developers.stellar.org)
- [Horizon API Reference](https://developers.stellar.org/api/introduction/)
- [Component README](./README.md)
- [Integration Examples](./INTEGRATION_EXAMPLES.tsx)
- [Component Tests](./src/dashboard/stellar/__tests__/StellarAccountViewer.test.tsx)

## Rollback Plan

If issues occur in production:

1. **Immediate**: Hide component with feature flag
```tsx
{featureFlags.showStellarViewer && (
  <StellarAccountViewer accountId={userAccount} />
)}
```

2. **Short term**: Disable auto-refresh to reduce API load
```tsx
<StellarAccountViewer accountId={userAccount} autoRefresh={false} />
```

3. **Medium term**: Increase refresh interval
```tsx
<StellarAccountViewer 
  accountId={userAccount} 
  autoRefreshInterval={60000}
/>
```

4. **Long term**: Revert component version
```bash
git revert <commit-hash>
npm run deploy
```

## Success Criteria

- ✅ Component displays account balance and operations
- ✅ Auto-refresh works every 30 seconds
- ✅ Unfunded accounts show helpful message
- ✅ Errors display with recovery options
- ✅ Mobile responsive and accessible
- ✅ Performance is acceptable (<2s initial load)
- ✅ No console errors or warnings
- ✅ Users can copy account address to clipboard
- ✅ Links to stellar.expert open correctly
- ✅ Works on target browsers

---

## Integration Sign-Off

- [ ] Code reviewed by team lead
- [ ] Tests passing (100% for component)
- [ ] Documentation updated
- [ ] Deployed to staging
- [ ] QA tested
- [ ] Deployed to production
- [ ] Monitoring configured
- [ ] Support team trained

**Integrator Name**: ________________
**Date**: ________________
**Notes**: ________________________________________________
