ProxyPay is a service that bridges Mobile Money (like MTN, Vodafone, etc.) with
  Stellar blockchain. It handles financial transactions, payment processing, and reconciliation
  between mobile money providers and Stellar.
  
  The project includes:
  
  - Core API: Express.js backend for processing payments and transactions
  - Blockchain integration: Stellar SDK integration for on-chain operations
  - Mobile Money providers: Integration with services like Africa's Talking
  - Payment processing: Transaction handling, ledger management, reconciliation
  - Database: PostgreSQL with migrations for schema management
  - Job queue: Bull for async task processing
  - Monitoring/Logging: Pino for logging, Datadog tracing, Prometheus metrics
  - Authentication: SAML, OAuth2 (Google), JWT
  - Testing: Jest, Playwright E2E, Pact contract testing, Load testing with K6
  - Smart contracts: Soroban WebAssembly contracts (Cargo/Rust)
  - SDKs: Auto-generated OpenAPI SDKs for clients
  - DevOps: Docker, Kubernetes, Terraform, Cloud Run deployment
