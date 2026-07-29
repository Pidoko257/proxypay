# SMS Notifications for Transaction Alerts

## Overview

The ProxyPay SMS Notification System enables users to receive real-time SMS updates on transaction status and critical account events. The system includes comprehensive delivery tracking, rate limiting, cost tracking, and user preference management.

## Features

### 1. **Transaction Alerts**
- Deposit/withdrawal success and failure notifications
- Real-time status updates to user's phone number
- Support for multiple languages via i18n

### 2. **Rate Limiting**
- 5 SMS per hour per user (configurable)
- 20 SMS per day per user (configurable)
- Redis-backed distributed rate limiting
- Respects quiet hours (e.g., 10 PM - 6 AM)

### 3. **User Preferences**
- Granular control over notification types
- Opt-in/opt-out mechanism
- Per-event type preferences (deposit, withdrawal, disputes, KYC)
- Quiet hours configuration
- SMS delivery preferences stored in database

### 4. **Delivery Tracking**
- Track every SMS sent with delivery status
- Monitor delivery success rates per provider
- Retry mechanism for failed messages (max 3 retries)
- Detailed delivery metadata (provider message ID, timestamps)

### 5. **Cost Tracking & Billing**
- Per-SMS cost calculation and aggregation
- Monthly billing summaries per user
- Provider pricing: Twilio ($0.0075/SMS), Africa's Talking ($0.005/SMS)
- Cost reports by message type and date range
- Export billing data to CSV

### 6. **Multi-Provider Support**
- Twilio integration (primary)
- Africa's Talking integration (fallback)
- Extensible provider interface

## Database Schema

### `sms_notification_preferences`
Stores user SMS notification settings:
```sql
- user_id (UUID) - User reference
- enabled (BOOLEAN) - Enable/disable SMS notifications
- opt_out (BOOLEAN) - User opted out
- opt_out_at (TIMESTAMP) - When user opted out
- notify_deposit_success (BOOLEAN) - Notify on successful deposit
- notify_deposit_failure (BOOLEAN) - Notify on failed deposit
- notify_withdraw_success (BOOLEAN) - Notify on successful withdrawal
- notify_withdraw_failure (BOOLEAN) - Notify on failed withdrawal
- notify_dispute_updates (BOOLEAN) - Notify on dispute updates
- notify_kyc_updates (BOOLEAN) - Notify on KYC status changes
- max_sms_per_hour (INT) - Hourly rate limit (default: 5)
- max_sms_per_day (INT) - Daily rate limit (default: 20)
- quiet_hours_start (INT) - Start hour (0-23) for quiet period
- quiet_hours_end (INT) - End hour (0-23) for quiet period
```

### `sms_delivery_tracking`
Logs every SMS sent with delivery status:
```sql
- id (UUID) - Record ID
- user_id (UUID) - User who received SMS
- transaction_id (UUID) - Associated transaction
- phone_number (VARCHAR) - Recipient phone number
- message_content (TEXT) - SMS message body
- message_type (VARCHAR) - Type of message (e.g., 'transaction_success')
- status (VARCHAR) - Delivery status: pending, sent, delivered, failed, skipped
- provider (VARCHAR) - SMS provider used (twilio, africastalking)
- provider_message_id (VARCHAR) - Provider's message ID
- cost_usd (DECIMAL) - Cost in USD
- retry_count (INT) - Number of retry attempts
- created_at (TIMESTAMP) - When SMS was created
- sent_at (TIMESTAMP) - When SMS was sent
- delivered_at (TIMESTAMP) - When SMS was delivered
- failed_at (TIMESTAMP) - When SMS failed
```

### `sms_billing_summary`
Aggregates SMS costs for billing:
```sql
- id (UUID) - Record ID
- user_id (UUID) - User being billed
- billing_period_start (TIMESTAMP) - Start of billing period
- billing_period_end (TIMESTAMP) - End of billing period
- sms_count_sent (INT) - Total SMS sent
- sms_count_delivered (INT) - Successful SMS
- sms_count_failed (INT) - Failed SMS
- total_cost_usd (DECIMAL) - Total cost for period
- transaction_sms (INT) - Count of transaction notifications
- kyc_sms (INT) - Count of KYC notifications
- alert_sms (INT) - Count of alert notifications
- finalized_at (TIMESTAMP) - When billing was finalized
```

### `sms_opt_out_history`
Audit trail of opt-in/out changes:
```sql
- id (UUID) - Record ID
- user_id (UUID) - User who changed preference
- action (VARCHAR) - 'opt_out', 'opt_in', or 'reactivate'
- reason (VARCHAR) - Reason for change
- initiated_by (VARCHAR) - 'user', 'admin', or 'system'
- created_at (TIMESTAMP) - When change occurred
```

## Configuration

Add to `.env`:

```bash
# SMS Provider Configuration
SMS_PROVIDER=twilio # 'twilio' or 'africastalking'
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+1234567890
SMS_DEFAULT_REGION=CM # ISO 3166-1 alpha-2 code for default country

# Optional: Africa's Talking
AFRICASTALKING_API_KEY=your_api_key
AFRICASTALKING_USERNAME=your_username
AFRICASTALKING_SENDER_ID=PROXYPAY

# SMS Limits (optional, defaults shown)
SMS_MAX_PER_HOUR=5
SMS_MAX_PER_DAY=20
SMS_RATE_LIMIT_WINDOW_MS=3600000 # 1 hour in milliseconds
```

## API Usage

### 1. Send Transaction Notification

```typescript
import { smsServiceEnhanced } from './services/smsEnhanced';

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
  {
    userId: 'user-123',
    transactionId: 'txn-123'
  }
);

// Result: { sent: true, trackingId: 'tracking-123', messageSid: 'msg-123', costUsd: 0.0075 }
```

### 2. Manage User Preferences

```typescript
import { smsPreferenceService } from './services/smsPreferenceService';

// Get user preferences
const prefs = await smsPreferenceService.getPreferences('user-123');

// Update preferences
await smsPreferenceService.updatePreferences('user-123', {
  maxSmsPerHour: 10,
  notifyDepositSuccess: true,
  notifyWithdrawFailure: true,
  quietHoursStart: 22,
  quietHoursEnd: 6
});

// Opt out
await smsPreferenceService.optOut('user-123', 'Too many messages');

// Opt back in
await smsPreferenceService.optIn('user-123');
```

### 3. Check Rate Limit Status

```typescript
const status = await smsServiceEnhanced.getRateLimitStatus('user-123');
// { currentCount: 3, limit: 5, resetAt: Date, canSend: true }
```

### 4. Get Billing Information

```typescript
import { smsBillingService } from './services/smsBillingService';

// Get monthly billing
const billing = await smsBillingService.getUserMonthlyBilling('user-123');

// Generate billing record for custom period
const period = await smsBillingService.generateBillingRecord(
  'user-123',
  new Date('2026-07-01'),
  new Date('2026-08-01')
);

// Get cost report
const report = await smsBillingService.generateCostReport(
  new Date('2026-07-01'),
  new Date('2026-08-01')
);

// Export to CSV
const csv = await smsBillingService.exportBillingDataCsv(
  new Date('2026-07-01'),
  new Date('2026-08-01')
);
```

### 5. Send Custom SMS

```typescript
const result = await smsServiceEnhanced.sendSms(
  '+237670000000',
  'Your custom message here',
  {
    userId: 'user-123',
    messageType: 'alert',
    respectPreferences: true,
    respectRateLimit: true
  }
);
```

## Notification Templates

Pre-built templates for common notification types:

```typescript
import { SmsNotificationTemplates } from './services/smsNotificationTemplates';

// Transaction success
const msg1 = SmsNotificationTemplates.transactionSuccess({
  transactionType: 'deposit',
  amount: '1000',
  provider: 'MTN',
  referenceNumber: 'REF-123',
  locale: 'en'
});

// KYC approval
const msg2 = SmsNotificationTemplates.kycVerificationApproved({
  kycLevel: 'full',
  locale: 'en'
});

// Dispute opened
const msg3 = SmsNotificationTemplates.disputeOpened({
  transactionReference: 'REF-123',
  amount: '500',
  locale: 'en'
});

// OTP
const msg4 = SmsNotificationTemplates.otp({
  otp: '123456',
  expiresIn: 5,
  locale: 'en'
});
```

## Testing

### Run SMS Tests

```bash
npm test -- sms-notifications.test.ts
```

### Use Testing Utilities

```typescript
import { smsTestingUtility } from './services/smsTestingTools';

// Send test SMS
const result = await smsTestingUtility.sendTestSms('+237670000000', 'test_type');

// Test all notifications
const results = await smsTestingUtility.testAllNotifications('+237670000000');

// Generate test report
const report = await smsTestingUtility.generateTestReport('user-123', '+237670000000');

// Test rate limiting
const rateLimitTest = await smsTestingUtility.testRateLimiting('user-123', '+237670000000');

// Simulate high volume
const simulation = await smsTestingUtility.simulateHighVolume(
  ['+237670000001', '+237670000002'],
  5 // Messages per phone
);
```

### Mock Service

```typescript
import { smsMockService } from './services/smsTestingTools';

// Record mock SMS
smsMockService.recordSend('+237670000000', 'Test message', { userId: 'user-123' });

// Get sent messages
const messages = smsMockService.getSentMessages();

// Get messages by phone
const phoneMessages = smsMockService.getMessagesByPhone('+237670000000');

// Export as JSON
const json = smsMockService.exportAsJson();

// Clear all
smsMockService.clear();
```

## Delivery Status Flow

```
pending → sent → delivered ✓
       ↘ → failed (with retry logic)
       ↘ → skipped (opted out, rate limited, quiet hours)
```

## Rate Limiting Behavior

When a user reaches their SMS limit:

1. **Hour limit reached**: SMS is skipped with `skipped_reason: 'rate_limited'`
2. **Quiet hours active**: SMS is skipped with `skipped_reason: 'quiet_hours'`
3. **User opted out**: SMS is skipped with `skipped_reason: 'user_opted_out'`
4. **Preferences disable event type**: SMS is skipped with `skipped_reason: 'user_opted_out'`

## Cost Tracking Details

### Provider Pricing
- **Twilio**: $0.0075 per SMS
- **Africa's Talking**: $0.005 per SMS
- **Fallback**: $0.01 per SMS

Each SMS is automatically tracked with its cost. Costs are aggregated by:
- User (per message, per billing period)
- Provider (for analytics)
- Message type (transaction, KYC, alert, other)
- Delivery status (sent, delivered, failed)

## Security Considerations

1. **Opt-out Enforcement**: Users who opt out cannot receive SMS regardless of system settings
2. **Rate Limiting**: Prevents SMS flooding and abuse
3. **Quiet Hours**: Respects user's time preferences
4. **Audit Trail**: All preference changes are logged in `sms_opt_out_history`
5. **Data Encryption**: Phone numbers are encrypted at rest (via application layer)
6. **Cost Control**: Built-in limits prevent runaway SMS spending

## Monitoring & Analytics

### Key Metrics

```typescript
// Delivery rate
const stats = await smsDeliveryTrackingModel.getUserStats(userId);
const deliveryRate = (stats.totalDelivered / stats.totalSent) * 100;

// Provider statistics
const providerStats = await smsDeliveryTrackingModel.getStatsByProvider(
  startDate,
  endDate
);

// Cost trends
const topUsers = await smsBillingService.getTopCostUsers(10);
const report = await smsBillingService.generateCostReport(startDate, endDate);
```

### Recommended Alerts

- Delivery rate drops below 95%
- Cost per user exceeds threshold
- High volume of rate-limited SMSes
- Provider failures or errors

## Integration with Transaction Flow

1. **After Transaction Completes**:
   ```typescript
   await smsServiceEnhanced.notifyTransactionEvent(
     user.phoneNumber,
     {
       referenceNumber: transaction.referenceNumber,
       type: transaction.type,
       amount: transaction.amount,
       provider: transaction.provider,
       kind: 'transaction_completed'
     },
     { userId: user.id, transactionId: transaction.id }
   );
   ```

2. **After KYC Status Changes**:
   ```typescript
   await smsServiceEnhanced.notifyKycUpdate(
     user.phoneNumber,
     'approved',
     { userId: user.id }
   );
   ```

3. **On Dispute Updates**:
   ```typescript
   await smsServiceEnhanced.notifyDisputeUpdate(
     user.phoneNumber,
     'upheld',
     { userId: user.id, transactionId: transaction.id }
   );
   ```

## Troubleshooting

### SMS Not Sending
1. Check if SMS provider is configured in `.env`
2. Verify user preferences: `canReceiveSms(userId)`
3. Check rate limit status: `getRateLimitStatus(userId)`
4. Check if in quiet hours: `isInQuietHours(userId)`
5. Review delivery tracking: `findByUserId(userId)` for status

### High Costs
1. Review top cost users: `getTopCostUsers()`
2. Check message type breakdown in billing report
3. Monitor delivery rates - retries increase costs
4. Consider increasing rate limits to reduce retry volume

### Delivery Issues
- Check provider connectivity
- Verify phone number format (E.164)
- Review provider-specific error messages
- Monitor provider status page

## Future Enhancements

- [ ] SMS scheduling (send at specific time)
- [ ] Batch SMS sending
- [ ] Custom SMS templates per user
- [ ] A/B testing of message content
- [ ] Machine learning-based delivery optimization
- [ ] SMS analytics dashboard
- [ ] Two-way SMS (reply to SMS)
- [ ] MMS support (media messages)
