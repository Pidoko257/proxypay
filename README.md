# Mobile Money to Stellar Bridge

[![CI](https://github.com/sublime247/mobile-money/actions/workflows/ci.yml/badge.svg)](https://github.com/sublime247/mobile-money/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/sublime247/mobile-money/branch/main/graph/badge.svg)](https://codecov.io/gh/sublime247/mobile-money)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A production-ready backend service bridging African mobile money providers (MTN, Airtel, Orange) with the Stellar blockchain network for seamless cross-border payments and remittances.

## 🌟 Overview

This platform connects traditional mobile money systems with blockchain technology, enabling:

- **Cross-border remittances** with lower fees than traditional services
- **Instant settlements** using Stellar's fast blockchain
- **Financial inclusion** by bridging mobile money (500M+ users in Africa) with global crypto markets
- **Compliance-first** approach with built-in KYC, AML monitoring, and transaction limits
- **Developer-friendly** REST + GraphQL APIs

### Use Cases

- **Remittances**: Send money globally via Stellar, recipient withdraws to mobile money
- **Cross-border payments**: Pay suppliers across African countries without expensive wire transfers
- **Stable savings**: Convert volatile local currency to USDC/XLM via mobile money
- **Merchant payments**: Accept crypto, settle in local mobile money
- **DeFi access**: Bridge between mobile money and Stellar DeFi protocols

## 🚀 Key Features

### Core
- Mobile Money Integration (MTN, Airtel, Orange)
- Stellar blockchain support (XLM, USDC, custom assets)
- Dual API (REST + GraphQL)
- Real-time processing with BullMQ/Redis
- WebSocket support for live updates

### Security & Compliance
- Multi-tier KYC/AML with transaction limits
- 2FA (TOTP), RBAC (Casbin)
- Rate limiting, audit logging
- Session security with device fingerprinting

### Financial
- Dynamic fees with VIP tiers
- Transaction limits (provider-specific, KYC-based)
- Vault system for secure fund storage
- Accounting integration (QuickBooks, Xero)
- Dispute management workflow

### Stellar Protocol Support
- SEP-10 (Web Authentication)
- SEP-12 (KYC API)
- SEP-24 (Hosted Deposit/Withdrawal)
- SEP-31 (Cross-Border Payments)
- SEP-38 (Quotes and Price Streams)

## 📋 Prerequisites

- Node.js 20+ (LTS)
- PostgreSQL 16+
- Redis 7+
- Docker (optional)

## 🛠️ Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/sublime247/mobile-money.git
cd mobile-money
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```bash
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/mobilemoney

# Redis
REDIS_URL=redis://localhost:6379

# Stellar
STELLAR_NETWORK=testnet  # or 'mainnet'
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_ISSUER_SECRET=S...

# Mobile Money Providers
MTN_API_KEY=your_mtn_api_key
AIRTEL_API_KEY=your_airtel_key
ORANGE_API_KEY=your_orange_key

# Security
JWT_SECRET=your_jwt_secret_min_32_chars
SESSION_SECRET=your_session_secret

# Optional: Notifications
SENDGRID_API_KEY=your_sendgrid_key
TWILIO_ACCOUNT_SID=your_twilio_sid
```

### 3. Setup Database

```bash
npm run migrate:up
npm run seed  # Optional: development data
```

### 4. Run

**Development:**
```bash
npm run dev
```

**Production:**
```bash
npm run build
npm start
```

**Docker:**
```bash
npm run docker:dev
```

Server starts at `http://localhost:3000`

## 🧪 Testing

```bash
npm test                    # All tests
npm run test:coverage       # With coverage
npm run test:watch          # Watch mode
npm run test:e2e            # End-to-end tests
npm run test:load           # Load testing
```

**Coverage thresholds:** Statements 20%, Branches 15%, Functions 25%, Lines 20%

> Coverage reports upload to [Codecov](https://codecov.io/gh/sublime247/mobile-money) on every push to main.

## 📚 API Documentation

### Interactive Docs (Development Only)

Start the dev server and visit:
- **Swagger UI**: `http://localhost:3000/docs`
- **OpenAPI JSON**: `http://localhost:3000/docs/openapi.json`

The API spec is auto-generated from Zod validation schemas at runtime—no manual YAML to maintain.

### How It Works

| Component | Purpose |
|-----------|---------|
| `src/openapi/schemas/` | Zod schemas with `.openapi()` annotations |
| `src/openapi/paths/` | Route registrations per domain |
| `src/openapi/generator.ts` | Assembles spec on server start |
| `src/routes/docs.ts` | Mounts Swagger UI (dev only) |

**To update docs:** Edit schemas in `src/openapi/schemas/`, restart server. Changes appear immediately.

### Core Endpoints

```bash
# Health
GET  /health                          # Service health
GET  /ready                           # Readiness (DB + Redis)

# Transactions
POST /api/transactions/deposit        # Mobile money → Stellar
POST /api/transactions/withdraw       # Stellar → Mobile money
GET  /api/transactions                # List (paginated)
GET  /api/transactions/:id            # Details
POST /api/transactions/:id/cancel     # Cancel pending
POST /api/transactions/:id/dispute    # Create dispute

# Auth
POST /api/auth/register               # Register
POST /api/auth/login                  # Login
POST /api/auth/2fa/enable             # Enable 2FA

# KYC
POST /api/kyc/submit                  # Submit documents
GET  /api/kyc/status                  # Check status

# Vaults
POST /api/vaults                      # Create vault
GET  /api/vaults                      # List vaults
POST /api/vaults/:id/transfer         # Deposit/withdraw
```

### GraphQL

```bash
POST /graphql
```

Playground: `http://localhost:3000/graphql` (dev only)

Example:
```graphql
query {
  transactions(limit: 10) {
    id
    amount
    status
    provider
  }
}

mutation {
  createDeposit(input: {
    amount: "10000"
    phoneNumber: "+237670000000"
    provider: MTN
  }) {
    id
    status
  }
}
```

### Authentication

Most endpoints require JWT:
```bash
Authorization: Bearer <token>
```

Admin operations use API key:
```bash
X-API-Key: <key>
```

## 🔐 Security

### Transaction Limits

| Type | Limit | Purpose |
|------|-------|---------|
| Minimum | 100 XAF | Prevent spam |
| Maximum | 1,000,000 XAF | Fraud prevention |

### KYC-Based Daily Limits

| Level | Daily Limit | Requirements |
|-------|-------------|--------------|
| Unverified | 10,000 XAF | Email only |
| Basic | 100,000 XAF | ID + selfie |
| Full | 1,000,000 XAF | Proof of address + video |

### Provider Limits

| Provider | Min | Max |
|----------|-----|-----|
| MTN | 100 XAF | 500,000 XAF |
| Airtel | 100 XAF | 1,000,000 XAF |
| Orange | 500 XAF | 750,000 XAF |

### AML Monitoring

Auto-flagging of suspicious transactions:
- Single transaction > 1,000,000 XAF
- 24h total > 5,000,000 XAF
- Rapid structuring (3+ mixed in 15 min)

## 🏗️ Architecture

### Stack

**Backend:** Node.js, TypeScript, Express, Apollo Server  
**Database:** PostgreSQL, Redis  
**Blockchain:** Stellar SDK, Horizon API  
**Jobs:** BullMQ, node-cron  
**Security:** Helmet, bcrypt, JWT, Speakeasy, Casbin  
**Monitoring:** Datadog, Sentry, Prometheus

### Project Structure

```
mobile-money/
├── src/
│   ├── auth/              # Authentication & authorization
│   ├── config/            # Configuration
│   ├── controllers/       # Request handlers
│   ├── graphql/           # GraphQL schema & resolvers
│   ├── jobs/              # Background jobs
│   ├── middleware/        # Express middleware
│   ├── models/            # Database models
│   ├── openapi/           # OpenAPI schema generation
│   ├── queue/             # Job queue management
│   ├── routes/            # API routes
│   ├── services/          # Business logic
│   │   ├── mobilemoney/   # Mobile money integrations
│   │   └── stellar/       # Stellar services
│   ├── stellar/           # SEP implementations
│   ├── tests/             # All test files
│   ├── types/             # TypeScript types
│   ├── utils/             # Helpers
│   └── websocket/         # WebSocket server
├── contracts/             # Stellar smart contracts (Rust)
├── benchmarks/            # Performance tests
├── cli/                   # CLI tool
├── bridge-starter-node/   # Webhook bridge starter
└── docs-portal/           # API documentation portal
```

## 🔄 Database Migrations

```bash
npm run migrate:create -- migration_name  # Create
npm run migrate:up                        # Run
npm run migrate:down                      # Rollback
npm run migrate:status                    # Check status
```

## 📊 Monitoring

### Metrics

Prometheus metrics at `/metrics`:
- Transaction counts by status
- API response times
- Queue depths
- Error rates
- Provider availability

### Health Checks

```bash
curl http://localhost:3000/health  # Liveness
curl http://localhost:3000/ready   # Readiness
```

### Logging

Structured JSON logging with levels: `error`, `warn`, `info`, `debug`

### Error Tracking

Sentry integration:
```bash
SENTRY_DSN=your_sentry_dsn
```

## 🚢 Deployment

### Docker

```bash
docker build -t mobile-money:latest .
docker run -p 3000:3000 --env-file .env mobile-money:latest
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mobile-money
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: mobile-money
        image: mobile-money:latest
        ports:
        - containerPort: 3000
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
        readinessProbe:
          httpGet:
            path: /ready
            port: 3000
```

## 📈 Performance

- **API Response**: < 100ms (p95)
- **Transaction Processing**: < 5s (end-to-end)
- **Throughput**: 1000+ req/s
- **Database Queries**: < 50ms (p95)

## 🐛 Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for detailed error codes and solutions.

### Common Issues

**Database connection fails:**
```bash
pg_isready -h localhost -p 5432
# Verify DATABASE_URL format
```

**Redis connection fails:**
```bash
redis-cli ping  # Should return PONG
```

**Stellar transactions fail:**
```bash
echo $STELLAR_NETWORK  # Should be 'testnet' or 'mainnet'
curl https://horizon-testnet.stellar.org
```

## 🤝 Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md).

### Workflow

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Make changes and run tests (`npm test`)
4. Commit (`git commit -m 'Add amazing feature'`)
5. Push (`git push origin feature/amazing-feature`)
6. Open Pull Request

Pre-commit hooks run ESLint, Prettier, TypeScript checks, and tests automatically.

### Good First Issues

Check [`good first issue`](https://github.com/sublime247/mobile-money/labels/good%20first%20issue) label.

## 🚨 Error Handling

Standardized error codes organized by category:
- **4000-4099**: Validation (HTTP 400)
- **4010-4019**: Authentication (HTTP 401)
- **4030-4039**: Authorization (HTTP 403)
- **4040-4049**: Not Found (HTTP 404)
- **4090-4099**: Conflict (HTTP 409)
- **4290-4299**: Rate Limit (HTTP 429)
- **5000+**: Server Errors (HTTP 500+)

See [src/constants/errorCodes.ts](src/constants/errorCodes.ts) for complete reference.

## 📝 License

MIT License - see [LICENSE](LICENSE) file.

## 🙏 Acknowledgments

- [Stellar Development Foundation](https://stellar.org)
- Mobile money providers (MTN, Airtel, Orange)
- Open source community

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/sublime247/mobile-money/issues)
- **Discussions**: [GitHub Discussions](https://github.com/sublime247/mobile-money/discussions)

## 🗺️ Roadmap

- [ ] Additional providers (Vodacom, Tigo)
- [ ] Mobile SDKs (iOS, Android)
- [ ] Merchant dashboard
- [ ] Advanced analytics
- [ ] Multi-currency support
- [ ] Stablecoin integration (USDC, USDT)
- [ ] DeFi protocol integrations

---

**Built with ❤️ for financial inclusion in Africa**
