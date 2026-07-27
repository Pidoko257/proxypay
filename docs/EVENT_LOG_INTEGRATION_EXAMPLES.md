# Event Log Integration Examples

This document provides practical examples of integrating the NoSQL event log system into ProxyPay.

## Table of Contents

1. [Application Startup](#application-startup)
2. [HTTP Middleware Integration](#http-middleware-integration)
3. [Transaction Flow](#transaction-flow)
4. [Payment Processing](#payment-processing)
5. [Authentication & Security](#authentication--security)
6. [Queries & Analytics](#queries--analytics)

## Application Startup

### Express Server Setup

```typescript
import express from "express";
import { EventLogService } from "src/services/eventLog/eventLogService";
import { createEventLogMiddleware } from "src/middleware/eventLogMiddleware";
import { EventLogConfig, EventCategory, EventSeverity } from "src/services/eventLog/types";

const app = express();

// Initialize event log service
const eventLogConfig: EventLogConfig = {
  provider: process.env.EVENT_LOG_PROVIDER || "dynamodb",
  batchSize: parseInt(process.env.EVENT_LOG_BATCH_SIZE || "100"),
  batchIntervalMs: parseInt(process.env.EVENT_LOG_BATCH_INTERVAL_MS || "5000"),
  enableBatching: true,
  enableMetrics: true,
  dynamodb: {
    region: process.env.AWS_REGION || "us-east-1",
    tableName: process.env.DYNAMODB_TABLE_NAME || "event-log",
    billingMode: "PAY_PER_REQUEST",
  },
};

let eventLogService: EventLogService;

async function startServer() {
  try {
    // Initialize event log
    eventLogService = new EventLogService(eventLogConfig);
    await eventLogService.initialize();

    // Log startup
    await eventLogService.log({
      category: EventCategory.SYSTEM,
      severity: EventSeverity.INFO,
      type: "app.startup",
      title: "ProxyPay Started",
      description: "Application startup completed successfully",
      source: "main",
      metadata: {
        version: process.env.APP_VERSION || "1.0.0",
        environment: process.env.NODE_ENV,
        port: process.env.PORT,
      },
      tags: ["startup", "system"],
    });

    // Add event log middleware
    app.use(createEventLogMiddleware(eventLogService));

    // Your other middleware and routes...
    app.listen(3000, () => {
      console.log("Server running on port 3000");
    });

    // Graceful shutdown
    process.on("SIGTERM", async () => {
      console.log("SIGTERM received, shutting down gracefully");
      await eventLogService.log({
        category: EventCategory.SYSTEM,
        severity: EventSeverity.INFO,
        type: "app.shutdown",
        title: "ProxyPay Shutdown",
        description: "Application shutdown initiated",
        source: "main",
        metadata: {
          reason: "SIGTERM",
          metrics: eventLogService.getMetrics(),
        },
      });
      await eventLogService.shutdown();
      process.exit(0);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
```

## HTTP Middleware Integration

### Automatic Request/Response Logging

```typescript
// middleware/eventLogMiddleware.ts is auto-applied
// All HTTP requests are logged with:
// - Method, path, status code
// - Duration
// - User ID
// - IP address
// - Error details

// Example logged event:
{
  category: "audit",
  type: "http.request",
  title: "POST /api/transactions/deposit - 200",
  metadata: {
    method: "POST",
    path: "/api/transactions/deposit",
    statusCode: 200,
    durationMs: 1250,
    userId: "user-123",
    ip: "192.168.1.1",
  },
  tags: ["http", "post", "status-200"],
}
```

## Transaction Flow

### Complete Transaction Lifecycle

```typescript
import { EventLogService } from "src/services/eventLog/eventLogService";
import { logTransactionEvent } from "src/middleware/eventLogMiddleware";

export class TransactionController {
  private eventLog: EventLogService;

  async initiatePayment(req: express.Request, res: express.Response) {
    const { phoneNumber, amount, provider } = req.body;
    const userId = req.user.id;
    const transactionId = generateId();
    const correlationId = req.headers["x-correlation-id"];

    try {
      // Step 1: Validate request
      await this.eventLog.log({
        category: "transaction",
        type: "transaction.deposit.initiated",
        title: "Deposit Transaction Initiated",
        transactionId,
        userId,
        correlationId,
        metadata: {
          amount,
          provider,
          phoneNumber: maskPhone(phoneNumber),
        },
        tags: ["deposit", provider],
      });

      // Step 2: Check KYC
      const kycStatus = await kyc.checkStatus(userId);
      if (!kycStatus.verified) {
        await this.eventLog.log({
          category: "compliance",
          type: "kyc.failed",
          severity: "warning",
          title: "KYC Check Failed",
          transactionId,
          userId,
          metadata: {
            reason: kycStatus.reason,
            level: kycStatus.level,
          },
        });
        throw new Error("KYC verification required");
      }

      // Step 3: Check limits
      const withinLimits = await limits.check(userId, amount, provider);
      if (!withinLimits) {
        await this.eventLog.log({
          category: "compliance",
          type: "limit.exceeded",
          severity: "warning",
          title: "Transaction Limit Exceeded",
          transactionId,
          userId,
          metadata: {
            amount,
            limit: withinLimits.limit,
            remaining: withinLimits.remaining,
          },
        });
        throw new Error("Transaction limit exceeded");
      }

      // Step 4: Check fraud
      const fraudCheck = await fraud.check(phoneNumber, amount);
      if (fraudCheck.flagged) {
        await this.eventLog.logSecurity(
          "fraud_flagged",
          "warning",
          userId,
          {
            transactionId,
            reason: fraudCheck.reason,
            score: fraudCheck.riskScore,
          }
        );
      }

      // Step 5: Initiate with provider
      const startTime = Date.now();
      const providerResponse = await provider.requestPayment(
        phoneNumber,
        amount
      );
      const duration = Date.now() - startTime;

      // Log provider interaction
      await logPaymentEvent(
        this.eventLog,
        provider,
        "initiated",
        "pending",
        transactionId,
        {
          amount,
          phoneNumber: maskPhone(phoneNumber),
          providerReference: providerResponse.reference,
        },
        duration
      );

      // Step 6: Store transaction
      const transaction = await db.transactions.create({
        id: transactionId,
        userId,
        provider,
        amount,
        phoneNumber,
        status: "pending",
        providerReference: providerResponse.reference,
        correlationId,
      });

      res.json({
        transactionId,
        status: "pending",
        amount,
        provider,
      });
    } catch (error) {
      // Log error
      await this.eventLog.logError(error, {
        transactionId,
        userId,
        context: "payment_initiation",
        provider,
      });

      res.status(400).json({ error: error.message });
    }
  }

  async confirmPayment(req: express.Request, res: express.Response) {
    const { transactionId, pin } = req.body;
    const userId = req.user.id;

    try {
      // Verify transaction exists and belongs to user
      const transaction = await db.transactions.findById(transactionId);
      if (!transaction || transaction.userId !== userId) {
        throw new Error("Transaction not found");
      }

      // Verify PIN
      const pinValid = await auth.verifyPin(userId, pin);
      if (!pinValid) {
        await this.eventLog.logAuth("pin", false, {
          transactionId,
          userId,
          reason: "invalid_pin",
        });
        throw new Error("Invalid PIN");
      }

      await this.eventLog.logAuth("pin", true, {
        transactionId,
        userId,
      });

      // Confirm with provider
      const providerResult = await providers[transaction.provider].confirmPayment(
        transaction.providerReference,
        pin
      );

      // Update transaction
      await db.transactions.update(transactionId, {
        status: providerResult.success ? "completed" : "failed",
        error: providerResult.error,
      });

      // Log completion
      await logTransactionEvent(
        this.eventLog,
        transactionId,
        "deposit",
        providerResult.success ? "completed" : "failed",
        {
          amount: transaction.amount,
          provider: transaction.provider,
          providerStatus: providerResult.status,
          fee: transaction.fee,
        },
        userId
      );

      res.json({
        transactionId,
        status: providerResult.success ? "completed" : "failed",
      });
    } catch (error) {
      await this.eventLog.logError(error, {
        transactionId,
        userId,
        context: "payment_confirmation",
      });
      res.status(400).json({ error: error.message });
    }
  }
}
```

## Payment Processing

### Provider Integration Logging

```typescript
import { logProviderEvent } from "src/middleware/eventLogMiddleware";

export class MTNPaymentProcessor {
  private eventLog: EventLogService;

  async sendPayout(
    transactionId: string,
    phoneNumber: string,
    amount: string
  ) {
    const startTime = Date.now();

    try {
      // Attempt payout
      const response = await this.mtnApi.sendPayout({
        externalId: transactionId,
        amount,
        payerMessage: "ProxyPay Remittance",
        payeeNote: "Remittance received",
        primaryParty: {
          partyIdType: "MSISDN",
          partyId: phoneNumber,
        },
      });

      const duration = Date.now() - startTime;

      // Log success
      await logProviderEvent(
        this.eventLog,
        "mtn",
        "payout",
        "completed",
        transactionId,
        {
          amount,
          phoneNumber: maskPhone(phoneNumber),
          mtnReference: response.financialTransactionId,
          status: response.status,
        },
        duration
      );

      return {
        success: true,
        reference: response.financialTransactionId,
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      // Log failure
      await logProviderEvent(
        this.eventLog,
        "mtn",
        "payout",
        "failed",
        transactionId,
        {
          amount,
          error: error.message,
          errorCode: error.code,
          retryable: error.retryable,
        },
        duration
      );

      // Log security event if suspicious
      if (error.code === "FRAUD_DETECTED") {
        await this.eventLog.logSecurity(
          "provider_fraud_alert",
          "critical",
          {
            transactionId,
            provider: "mtn",
            mtnErrorCode: error.code,
          }
        );
      }

      throw error;
    }
  }
}
```

## Authentication & Security

### Login & 2FA Flow

```typescript
export class AuthController {
  private eventLog: EventLogService;

  async login(req: express.Request, res: express.Response) {
    const { email, password } = req.body;
    const ipAddress = req.ip;

    try {
      // Check brute force
      const attempts = await this.eventLog.query({
        userId: email,
        category: "auth",
        type: "auth.login",
        startDate: Date.now() - 15 * 60 * 1000, // Last 15 min
      });

      if (attempts.count > 5) {
        await this.eventLog.logAuth("login", false, {
          reason: "brute_force_detected",
          ipAddress,
          attempts: attempts.count,
        });
        throw new Error("Too many login attempts");
      }

      // Verify credentials
      const user = await db.users.findByEmail(email);
      const valid = user && (await bcrypt.compare(password, user.passwordHash));

      if (!valid) {
        await this.eventLog.logAuth(email, "login", false, {
          reason: "invalid_credentials",
          ipAddress,
        });
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }

      // Success
      await this.eventLog.logAuth(user.id, "login", true, {
        ipAddress,
        method: "password",
      });

      // Check if 2FA required
      if (user.twoFactorEnabled) {
        // Send OTP
        await this.eventLog.log({
          category: "auth",
          type: "auth.2fa.otp_sent",
          title: "2FA OTP Sent",
          userId: user.id,
          metadata: {
            method: "email",
            maskedEmail: maskEmail(user.email),
            ipAddress,
          },
        });

        res.json({
          status: "2fa_required",
          sessionToken: await this.generateSessionToken(user.id),
        });
      } else {
        res.json({
          token: await this.generateToken(user.id),
          user: user,
        });
      }
    } catch (error) {
      await this.eventLog.logError(error, {
        context: "login",
        email: maskEmail(email),
      });
      res.status(500).json({ error: "Login failed" });
    }
  }

  async verify2FA(req: express.Request, res: express.Response) {
    const { sessionToken, code } = req.body;

    try {
      const user = await this.getSessionUser(sessionToken);

      // Verify OTP
      const valid = await speakeasy.totp.verify({
        secret: user.twoFactorSecret,
        encoding: "base32",
        token: code,
        window: 2,
      });

      if (!valid) {
        await this.eventLog.logAuth(user.id, "2fa", false, {
          reason: "invalid_code",
        });
        throw new Error("Invalid 2FA code");
      }

      // Success
      await this.eventLog.logAuth(user.id, "2fa", true, {
        method: "totp",
      });

      res.json({
        token: await this.generateToken(user.id),
        user,
      });
    } catch (error) {
      await this.eventLog.logError(error, {
        context: "2fa_verification",
      });
      res.status(401).json({ error: "2FA verification failed" });
    }
  }
}
```

## Queries & Analytics

### Querying Event Data

```typescript
export class EventAnalyticsService {
  private eventLog: EventLogService;

  /**
   * Get transaction timeline
   */
  async getTransactionTimeline(transactionId: string) {
    const events = await this.eventLog.queryByTransactionId(transactionId);

    return events
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((e) => ({
        time: new Date(e.timestamp).toISOString(),
        event: e.type,
        status: e.status,
        duration: e.durationMs,
        details: e.metadata,
      }));
  }

  /**
   * Get user activity summary
   */
  async getUserActivity(userId: string, days = 7) {
    const events = await this.eventLog.queryByUserId(userId);

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const filtered = events.filter((e) => e.timestamp > startDate.getTime());

    return {
      totalEvents: filtered.length,
      byCategory: this.countBy(filtered, "category"),
      bySeverity: this.countBy(filtered, "severity"),
      errors: filtered.filter((e) => e.errorCode),
      lastActivity: filtered[filtered.length - 1]?.timestamp,
    };
  }

  /**
   * Provider performance report
   */
  async getProviderReport(provider: string, days = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const response = await this.eventLog.query({
      providerId: provider,
      startDate,
      limit: 1000,
    });

    const events = response.events;
    const durations = events
      .filter((e) => e.durationMs)
      .map((e) => e.durationMs || 0);

    const successCount = events.filter((e) => e.status === "completed").length;
    const failureCount = events.filter((e) => e.status === "failed").length;

    return {
      provider,
      period: `${days} days`,
      summary: {
        totalRequests: events.length,
        successCount,
        failureCount,
        successRate: (successCount / events.length) * 100,
      },
      performance: {
        avgDuration: durations.reduce((a, b) => a + b, 0) / durations.length,
        minDuration: Math.min(...durations),
        maxDuration: Math.max(...durations),
        p50: this.percentile(durations, 50),
        p95: this.percentile(durations, 95),
        p99: this.percentile(durations, 99),
      },
      errors: this.countBy(
        events.filter((e) => e.errorCode),
        "errorCode"
      ),
    };
  }

  /**
   * Fraud detection report
   */
  async getFraudReport(days = 7) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const response = await this.eventLog.query({
      category: "security",
      severity: ["warning", "critical"],
      startDate,
      limit: 1000,
    });

    const events = response.events;

    return {
      period: `${days} days`,
      totalIncidents: events.length,
      byType: this.countBy(events, "type"),
      affectedUsers: [...new Set(events.map((e) => e.userId))].length,
      incidents: events
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 20),
    };
  }

  private countBy<T extends Record<string, any>>(
    items: T[],
    key: keyof T
  ): Record<string, number> {
    return items.reduce(
      (acc, item) => {
        const k = String(item[key]);
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );
  }

  private percentile(arr: number[], p: number): number {
    const sorted = arr.sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[index] || 0;
  }
}
```

---

**See Also**:
- [NoSQL Event Log Guide](./NOSQL_EVENT_LOG_GUIDE.md)
- [Event Log API Reference](#api-reference)
