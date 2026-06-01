# Mobile Money Codebase Exploration Report
## SEP-38 & Stellar Protocol Implementation Patterns

---

## 1. Current SEP-38 Implementation Status

### File Location
- **Path**: [src/stellar/sep38.ts](src/stellar/sep38.ts)
- **Status**: ✅ Partially Implemented | ❌ Not Mounted in Router

### Current Implementation Details

**Routes Implemented:**
- `GET /info` - Lists supported asset pairs
- `GET /prices?sell_asset=...&buy_asset=...` - Fetches current price
- `POST /quote` - Creates a new quote with TTL
- `GET /quote/:id` - Retrieves quote by ID

**Key Components:**
```typescript
// Quote caching with TTL
const quoteCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Asset pair configuration
interface AssetPair {
  sell_asset: string;
  buy_asset: string;
}

// Supported pairs (6 pairs)
const SUPPORTED_ASSET_PAIRS: AssetPair[] = [
  { sell_asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", 
    buy_asset: "iso4217:USD" },
  // ... more pairs
];
```

**Exchange Rate Service:**
- Maps asset identifiers to currency codes
- Integrates with `currencyService.convert()` 
- Adds 0.2% price variation to simulate market rates
- Returns 7 decimal precision

**Issues:**
- ❌ Not mounted in [src/index.ts](src/index.ts) - needs route registration
- ⚠️ No Zod schema validation for request bodies
- ⚠️ Quote storage is memory-only (no Redis persistence)
- ⚠️ No database persistence option

---

## 2. Existing SEP Protocol Implementations (Reference Patterns)

### SEP-12: KYC API
**File**: [src/stellar/sep12.ts](src/stellar/sep12.ts)

**Key Pattern:**
```typescript
// Validation schema using Zod
const PutCustomerSchema = z.object({
  account: z.string().optional(),
  memo: z.string().optional(),
  memo_type: z.enum(["id", "hash", "text"]).optional(),
  first_name: z.string().optional(),
  email_address: z.string().email().optional(),
  // ... more fields
});

// In route handler
router.put("/customer", async (req: Request, res: Response) => {
  try {
    const validatedData = PutCustomerSchema.parse(req.body);
    // Process validated data
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Validation failed", details: error.issues });
    }
  }
});
```

**Implementation**: Field definitions, customer verification flows, SEP-12 customer response structure

---

### SEP-24: Deposits & Withdrawals
**File**: [src/stellar/sep24.ts](src/stellar/sep24.ts)

**Key Pattern:**
- Transaction state machine (pending_user_transfer_start → completed/failed)
- Interactive URL generation for user flows
- Asset configuration with fees
- In-memory transaction store (can be replaced with database)

**Asset Configuration:**
```typescript
const getSep24Config = () => ({
  webAuthDomain: process.env.STELLAR_WEB_AUTH_DOMAIN,
  interactiveUrlBase: process.env.SEP24_INTERACTIVE_URL,
  assets: {
    XLM: {
      asset_code: "XLM",
      deposits_enabled: true,
      withdrawals_enabled: true,
      min_amount: 1,
      max_amount: 1000000,
    }
  }
});
```

---

### SEP-31: Cross-Border Payments
**File**: [src/stellar/sep31.ts](src/stellar/sep31.ts)

**Key Pattern:**
```typescript
const sep31Limiter = process.env.NODE_ENV === "test" 
  ? (req: any, res: any, next: any) => next()
  : rateLimit({
      windowMs: 60 * 1000,
      max: 10, // Strict rate limit
      message: { error: "Too many requests" },
    });

router.get("/info", sep31Limiter, async (req: Request, res: Response) => {
  const asset = getConfiguredPaymentAsset();
  const info = { receive: { [assetCode]: { ... } } };
  return res.json(info);
});

router.post("/transactions", sep31Limiter, async (req: Request, res: Response) => {
  // Validate fields
  // Create transaction with UUID
  // Store metadata
});
```

**Route Registration** (in [src/index.ts](src/index.ts)):
```typescript
app.use("/sep31", sep31Router);
app.use("/sep24", sep24Router);
app.use("/sep12", createSep12Router(pool));
```

---

## 3. Exchange Rate Service Implementation

**File**: [src/services/currency.ts](src/services/currency.ts)

### Features:
- **External API**: exchangerate-api.com v6
- **Cache**: 1-hour TTL with automatic refresh
- **Fallback**: Static rates for graceful degradation
- **Supported Currencies**: USD, XAF, NGN, KES, GHS, TZS, ZMW, RWF

### Code Pattern:
```typescript
export class CurrencyService {
  private readonly apiBaseUrl = "https://v6.exchangerate-api.com/v6";
  private readonly cacheTtlMs = 60 * 60 * 1000; // 1 hour
  private cache: { rates: ExchangeRates; fetchedAt: Date } | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  async initialize(): Promise<void> {
    await this.fetchRates();
    this.refreshTimer = setInterval(() => {
      this.fetchRates().catch((err) => console.error("Refresh failed:", err));
    }, this.cacheTtlMs);
  }

  convert(
    amount: number,
    from: SupportedCurrency,
    to: SupportedCurrency,
  ): ConversionResult {
    const rates = this.getRates();
    const usdEquivalent = amount / rates[from];
    const convertedAmount = usdEquivalent * rates[to];
    return {
      originalAmount: amount,
      originalCurrency: from,
      convertedAmount: Math.round(convertedAmount * 1e7) / 1e7, // 7 dp
      baseCurrency: to,
      rate: Math.round(rate * 1e7) / 1e7,
    };
  }
}

export const currencyService = new CurrencyService();
```

### Integration in SEP-38:
```typescript
try {
  if (sellCode === "XLM" && buyCode === "USD") {
    rate = xlmPriceUsd;
  } else if (sellCode === "USD" && buyCode === "XLM") {
    rate = 1 / xlmPriceUsd;
  } else {
    // Use currencyService for fiat conversions
    rate = currencyService.convert(1, sellCode, buyCode).rate;
  }
} catch (e) {
  return null;
}
```

---

## 4. Redis Integration Patterns

**File**: [src/config/redis.ts](src/config/redis.ts)

### Connection Management:
```typescript
const redisClient = createClient({
  url: activeRedisUrl,
  socket: {
    reconnectStrategy: (retries, cause) => {
      if (SENTINEL_ENABLED) {
        void scheduleMasterRefresh("reconnect");
      }
      if (retries > 100) {
        return new Error("Max reconnection attempts reached");
      }
      return Math.min(100 + retries * 200, 3000);
    },
  },
});
```

### Usage Patterns:

#### 1. Session Store
```typescript
// In src/index.ts
const redisStore = createRedisStore();
app.use(
  session({
    store: redisStore,
    secret: sessionSecret,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: SESSION_TTL_SECONDS * 1000,
    },
  }),
);
```

#### 2. WebSocket Pub/Sub Pattern
**File**: [src/websocket/websocketManager.ts](src/websocket/websocketManager.ts)

```typescript
export class WebSocketManager {
  private redisSub: RedisClientType | null = null;
  private redisPub: RedisClientType | null = null;
  private readonly REDIS_CHANNEL = "transaction.updates";

  private async setupRedis(): Promise<void> {
    this.redisSub = createClient({ url: process.env.REDIS_URL });
    this.redisPub = createClient({ url: process.env.REDIS_URL });
    
    await this.redisSub.connect();
    await this.redisPub.connect();

    // Subscribe to transaction updates
    await this.redisSub.subscribe(this.REDIS_CHANNEL, (message) => {
      const update = JSON.parse(message);
      this.broadcastToSubscribers(update);
    });
  }

  // Broadcast to all subscribed clients + Redis
  broadcastTransactionUpdate(payload: TransactionUpdatePayload): void {
    // Send to local WebSocket clients
    const clientIds = this.subscriptions.get(payload.id) || new Set();
    clientIds.forEach(clientId => {
      const client = this.clients.get(clientId);
      this.sendToClient(client, { type: "transaction.update", data: payload });
    });

    // Publish to Redis for other server instances
    this.redisPub?.publish(
      this.REDIS_CHANNEL,
      JSON.stringify(payload)
    ).catch(err => console.error("Redis publish failed:", err));
  }
}
```

#### 3. Quote Persistence Option (NOT IMPLEMENTED):
```typescript
// Proposed pattern (currently uses in-memory cache)
async storeQuote(quote: Quote): Promise<void> {
  const ttl = Math.ceil((new Date(quote.expires_at).getTime() - Date.now()) / 1000);
  await redisClient.setEx(`quote:${quote.id}`, ttl, JSON.stringify(quote));
}

async retrieveQuote(id: string): Promise<Quote | null> {
  const data = await redisClient.get(`quote:${id}`);
  return data ? JSON.parse(data) : null;
}
```

---

## 5. Zod Validation Schema Patterns

### Pattern 1: Basic Field Validation
**From** [src/middleware/validateTransaction.ts](src/middleware/validateTransaction.ts):
```typescript
const transactionSchema = z.object({
  amount: z.number().positive({ message: "Amount must be positive" }),
  phoneNumber: z
    .string()
    .regex(/^\+?\d{10,15}$/, { message: "Invalid phone format" }),
  provider: z.enum(["mtn", "airtel", "orange"]),
  stellarAddress: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, { message: "Invalid Stellar address" }),
  userId: z.string().nonempty(),
});

export const validateTransaction = (req: Request, res: Response, next: NextFunction) => {
  try {
    transactionSchema.parse(req.body);
    next();
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        error: "Validation failed",
        details: err.issues,
      });
    }
  }
};
```

### Pattern 2: Nested Objects
**From** [src/controllers/kycController.ts](src/controllers/kycController.ts):
```typescript
const CreateApplicantSchema = z.object({
  first_name: z.string().min(1, "First name is required"),
  last_name: z.string().min(1, "Last name is required"),
  email: z.string().email("Invalid email format").optional(),
  address: z
    .object({
      flat_number: z.string().optional(),
      street: z.string().min(1, "Street is required"),
      town: z.string().min(1, "Town is required"),
      postcode: z.string().min(1, "Postcode is required"),
      country: z.string().length(3, "Country code must be 3 chars"),
    })
    .optional(),
});

// Usage
const validatedData = CreateApplicantSchema.parse(req.body);
```

### Pattern 3: Enum Validation
**From** [src/stellar/sep12.ts](src/stellar/sep12.ts):
```typescript
const PutCustomerSchema = z.object({
  memo_type: z.enum(["id", "hash", "text"]).optional(),
  // ... more fields
});
```

### Pattern 4: Custom Validation
**From** [src/services/kyc.ts](src/services/kyc.ts):
```typescript
const UploadDocumentSchema = z.object({
  applicant_id: z.string(),
  type: z.nativeEnum(DocumentType),
  side: z.enum(["front", "back"]).optional(),
  filename: z.string().min(1),
  data: z.string().min(1),
});
```

---

## 6. Express Route Setup & Middleware Patterns

### File: [src/index.ts](src/index.ts)

### Middleware Stack Order:
```typescript
import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import compression from "compression";
import cors from "cors";

// 1. Initialize app
const app = express();

// 2. Security middleware
app.use(helmet());

// 3. Compression
app.use(compression({
  threshold: 1024,
  level: 6,
  filter: (req, res) => {
    // Skip compression for binary types
    const contentType = res.getHeader("content-type");
    return !(contentType?.includes("image/") || contentType?.includes("video/"));
  }
}));

// 4. CORS
app.use(cors(createCorsOptions()));

// 5. Parsing
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// 6. Rate limiting (global)
const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX_REQUESTS,
  standardHeaders: true,
});
app.use(limiter);

// 7. Request tracking
app.use(responseTime);
app.use(requestId);

// 8. Session
app.use(session({ store: redisStore, ... }));

// 9. Health endpoints
app.get("/health", (req, res) => res.json({ status: "ok" }));
app.get("/ready", async (req, res) => { /* health checks */ });

// 10. API routes with versioning
app.use("/api/v1/transactions", transactionRoutesV1);
app.use("/api/v1/disputes", disputeRoutesV1);
app.use("/sep31", sep31Router);
app.use("/sep24", sep24Router);
app.use("/sep12", createSep12Router(pool));

// 11. Error handling (MUST be last)
app.use(Sentry.expressErrorHandler());
app.use(errorHandler);
```

### Rate Limiter Pattern:
```typescript
// Global
const limiter = rateLimit({
  windowMs: 900000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Per-route (stricter)
const sep31Limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many requests" },
});
router.post("/transactions", sep31Limiter, handler);

// Test mode bypass
const testLimiter = process.env.NODE_ENV === "test"
  ? (req, res, next) => next()
  : limiter;
```

### Authentication Middleware Pattern
**File**: [src/middleware/auth.ts](src/middleware/auth.ts)

```typescript
export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  // Check API key
  const apiKey = req.header("X-API-Key");
  if (apiKey === process.env.ADMIN_API_KEY) {
    (req as AuthRequest).user = { id: "admin-system", role: "admin" };
    return next();
  }

  // Check Bearer token (JWT or OAuth)
  const authorization = req.header("Authorization");
  const bearerToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

  if (bearerToken) {
    try {
      const claims = verifyOAuthAccessToken(bearerToken);
      (req as AuthRequest).user = {
        id: claims.sub,
        role: claims.role,
        clientId: claims.client_id,
        scopes: claims.scope.split(/\s+/),
      };
      return next();
    } catch (err) {
      return res.status(401).json({ error: "Invalid token" });
    }
  }

  return res.status(401).json({ error: "Authentication required" });
};
```

---

## 7. Other Stellar Protocol Endpoints

### File: [src/routes/stellar.ts](src/routes/stellar.ts)

**Endpoint**: `GET /balance/:address`

```typescript
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
});

// 5 min cache
const cache = new NodeCache({ stdTTL: 300 });

router.get("/balance/:address", limiter, async (req: Request, res: Response) => {
  const { address } = req.params;

  // Validate format
  if (!/^G[A-Z0-9]{20,60}$/.test(address)) {
    return res.status(400).json({ error: "Invalid Stellar address" });
  }

  // Check cache
  const cached = cache.get(address);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    // Fetch from Horizon
    const server = new Horizon.Server(process.env.STELLAR_HORIZON_URL);
    const account = await server.loadAccount(address);

    const response = {
      address,
      balance: account.balances.find(b => b.asset_type === "native")?.balance || "0",
      balanceStroops: (parseFloat(balance) * 1e7).toFixed(0),
      assets: account.balances
        .filter(b => b.asset_type !== "native")
        .map(b => ({
          asset_code: b.asset_code,
          asset_issuer: b.asset_issuer,
          balance: b.balance,
        })),
    };

    cache.set(address, response);
    return res.json(response);
  } catch (error: any) {
    if (error?.response?.status === 404) {
      return res.status(404).json({ error: "Account not found" });
    }
    return res.status(500).json({ error: "Failed to fetch balance" });
  }
});
```

---

## 8. Key Implementation Details

### NodeCache vs Redis
- **NodeCache**: In-memory cache for single instance (SEP-38 quotes, Horizon balance)
- **Redis**: Distributed cache for multi-instance scenarios (sessions, pub/sub)

### Error Response Standard
```typescript
// Success
res.json({ data: {...} })

// Validation error
res.status(400).json({ error: "Validation failed", details: [...] })

// Not found
res.status(404).json({ error: "Quote not found" })

// Server error
res.status(500).json({ error: "Internal server error" })
```

### Route Handler Pattern
```typescript
router.post("/endpoint", limiter, async (req: Request, res: Response) => {
  try {
    // 1. Validate input
    const validated = SomeSchema.parse(req.body);
    
    // 2. Business logic
    const result = await someService.process(validated);
    
    // 3. Return success
    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Validation failed", details: error.issues });
    }
    console.error("Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});
```

---

## 9. Recommended Next Steps for SEP-38

### Priority 1: Integration
- [ ] Add Zod validation schemas for `/quote` and `/prices` endpoints
- [ ] Mount SEP-38 router in [src/index.ts](src/index.ts) at line ~252
- [ ] Add rate limiting (e.g., 20 req/min)

### Priority 2: Persistence
- [ ] Consider Redis integration for quote persistence (optional, current TTL is 5 min)
- [ ] Add database schema for historical quotes (audit trail)

### Priority 3: Testing
- [ ] Add unit tests for exchange rate calculations
- [ ] Test SEP-38 spec compliance
- [ ] Add integration tests for quote workflow

### Priority 4: Enhancement
- [ ] Add more asset pairs configuration (via environment variables)
- [ ] Implement real exchange rate API (currently uses mock + currencyService)
- [ ] Add webhook support for quote expiration events

---

## 10. File Location Summary

| Component | File | Purpose |
|-----------|------|---------|
| SEP-38 Router | [src/stellar/sep38.ts](src/stellar/sep38.ts) | Quote & price endpoints |
| SEP-12 KYC | [src/stellar/sep12.ts](src/stellar/sep12.ts) | Customer verification |
| SEP-24 Deposits | [src/stellar/sep24.ts](src/stellar/sep24.ts) | Deposit/withdrawal flows |
| SEP-31 Payments | [src/stellar/sep31.ts](src/stellar/sep31.ts) | Cross-border payments |
| Currency Service | [src/services/currency.ts](src/services/currency.ts) | Exchange rates & conversion |
| Redis Config | [src/config/redis.ts](src/config/redis.ts) | Redis client & session store |
| WebSocket Manager | [src/websocket/websocketManager.ts](src/websocket/websocketManager.ts) | Real-time updates via Redis pub/sub |
| Auth Middleware | [src/middleware/auth.ts](src/middleware/auth.ts) | JWT/OAuth authentication |
| Validation Middleware | [src/middleware/validateTransaction.ts](src/middleware/validateTransaction.ts) | Zod-based validation |
| Stellar Balance | [src/routes/stellar.ts](src/routes/stellar.ts) | Balance check endpoint |
| Main App | [src/index.ts](src/index.ts) | Route mounting & middleware setup |
| KYC Controller | [src/controllers/kycController.ts](src/controllers/kycController.ts) | KYC handler with Zod schemas |
