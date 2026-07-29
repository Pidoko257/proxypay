# SMS Notifications - Quick Start Guide

## 1. Setup (30 seconds)

### Add to `.env`:
```bash
SMS_PROVIDER=twilio
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+1234567890
SMS_DEFAULT_REGION=CM
```

### Run migrations:
```bash
npm run migrate:up
```

## 2. Send Your First SMS (2 minutes)

```typescript
import { smsServiceEnhanced } from './services/smsEnhanced';

// Send transaction notification
const result = await smsServiceEnhanced.notifyTransactionEvent(
  '+237670000000',
  {
    referenceNumber: 'TXN-123456',
    type: 'deposit',
    amount: '1000',
    provider: 'MTN',
    kind: 'transaction_completed',
    locale: 'en'
  },
  { userId: 'user-123', transactionId: 'txn-123' }
);

console.log('SMS sent:', result.trackingId);
```

## 3. Manage User Preferences (2 minutes)

```typescript
import { smsPreferenceService } from './services/smsPreferenceService';

// Get user preferences
const prefs = await smsPreferenceService.getPreferences('user-123');

// Update preferences
await smsPreferenceService.updatePreferences('user-123', {
  maxSmsPerHour: 10,
  notifyDepositSuccess: true,
  quietHoursStart: 22,  // 10 PM
  quietHoursEnd: 6      // 6 AM
});

// User opt-out
await smsPreferenceService.optOut('user-123', 'Too many messages');

// User opt-back-in
await smsPreferenceService.optIn('user-123');
```

## 4. Check Billing (1 minute)

```typescript
import { smsBillingService } from './services/smsBillingService';

// Get monthly billing
const billing = await smsBillingService.getUserMonthlyBilling('user-123');
console.log('Cost this month:', billing.totalCostUsd);

// Get cost report
const report = await smsBillingService.generateCostReport(
  new Date('2026-07-01'),
  new Date('2026-08-01')
);
console.log('Total SMS:', report.totalSmsCount);
console.log('Total cost:', report.totalCostUsd);
```

## 5. Test SMS (1 minute)

```typescript
import { smsTestingUtility } from './services/smsTestingTools';

// Send test SMS
const result = await smsTestingUtility.sendTestSms('+237670000000', 'test');

// Generate full test report
const report = await smsTestingUtility.generateTestReport('user-123', '+237670000000');
console.log('Report:', report.summary);
```

## Common Tasks

### Check if user can receive SMS
```typescript
const canReceive = await smsPreferenceService.canReceiveSmsForEvent(
  'user-123', 
  'deposit_success'
);
```

### Get rate limit status
```typescript
const status = await smsServiceEnhanced.getRateLimitStatus('user-123');
console.log(`${status.currentCount}/${status.limit} SMS used this hour`);
```

### Send custom SMS
```typescript
await smsServiceEnhanced.sendSms(
  '+237670000000',
  'Your custom message',
  { userId: 'user-123', messageType: 'alert' }
);
```

### Get delivery stats
```typescript
const stats = await smsPreferenceService.getDeliveryStats('user-123');
console.log('Success rate:', stats.successRate);
```

### Export billing to CSV
```typescript
const csv = await smsBillingService.exportBillingDataCsv(
  new Date('2026-07-01'),
  new Date('2026-08-01')
);
// Save to file or send to accounting
```

## Key Files

| File | Purpose |
|------|---------|
| `smsEnhanced.ts` | Core SMS sending with tracking |
| `smsPreferenceService.ts` | User preferences & opt-out |
| `smsBillingService.ts` | Cost tracking & billing |
| `smsNotificationTemplates.ts` | Pre-built message templates |
| `smsTestingTools.ts` | Testing utilities |
| `smsDeliveryTracking.ts` | Delivery model |
| `smsPreferences.ts` | Preferences model |

## Configuration

| Setting | Default | Purpose |
|---------|---------|---------|
| `SMS_PROVIDER` | none | Provider: 'twilio', 'africastalking' |
| `SMS_MAX_PER_HOUR` | 5 | Rate limit per hour |
| `SMS_MAX_PER_DAY` | 20 | Rate limit per day |
| `SMS_DEFAULT_REGION` | CM | Default country for phone parsing |

## Database Tables

| Table | Purpose |
|-------|---------|
| `sms_notification_preferences` | User preferences |
| `sms_delivery_tracking` | SMS delivery logs |
| `sms_billing_summary` | Cost aggregation |
| `sms_opt_out_history` | Audit trail |
| `sms_rate_limit_events` | Rate limit analytics |

## Monitoring

Watch these metrics:
- **Delivery rate** (target >95%)
- **Cost per user/month**
- **Rate-limited SMS count**
- **Provider failures**

## Troubleshooting

| Issue | Solution |
|-------|----------|
| SMS not sending | Check: provider config, user preferences, rate limit |
| High costs | Review top users, check delivery rate |
| Delivery failures | Check phone format (E.164), provider status |
| Rate limit too strict | Update: `updatePreferences(userId, { maxSmsPerHour: X })` |

## Next Steps

1. Add SMS to your transaction flow
2. Test with test utility
3. Configure rate limits for your users
4. Set up billing alerts
5. Train support team on SMS opt-out

## API Reference

See `/docs/SMS_NOTIFICATIONS.md` for complete API reference.
