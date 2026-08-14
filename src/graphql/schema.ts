import { gql } from "apollo-server-express";

export const typeDefs = gql`
  # ---------------------------------------------------------------------------
  # Scalars
  # ---------------------------------------------------------------------------

  """ISO 8601 date-time string"""
  scalar DateTime

  """Arbitrary JSON object"""
  scalar JSON

  # ---------------------------------------------------------------------------
  # Enums
  # ---------------------------------------------------------------------------

  enum TransactionStatus {
    pending
    completed
    failed
    cancelled
    review
    dispute
    reversed
    clawed_back
  }

  enum TransactionType {
    deposit
    withdraw
    transfer
    conversion
  }

  enum KYCLevel {
    none
    basic
    full
  }

  enum KYCStatus {
    pending
    approved
    rejected
    review
  }

  enum DisputeStatus {
    open
    investigating
    resolved
    rejected
    reversed
    upheld
  }

  enum MerchantStatus {
    pending
    active
    suspended
    rejected
  }

  enum VaultTransactionType {
    deposit
    withdraw
  }

  enum SupportedCurrency {
    USD
    XAF
    NGN
    KES
    GHS
    TZS
    ZMW
    RWF
  }

  enum CurrencyConversionDirection {
    sell
    buy
  }

  enum UserStatus {
    active
    frozen
    suspended
  }

  # ---------------------------------------------------------------------------
  # Core types
  # ---------------------------------------------------------------------------

  type User {
    id: ID!
    phoneNumber: String!
    email: String
    displayName: String
    kycLevel: KYCLevel!
    kycStatus: KYCStatus
    status: UserStatus!
    preferredLanguage: String
    twoFactorEnabled: Boolean!
    createdAt: DateTime!
    updatedAt: DateTime!
    """Preferred display currency for this user"""
    preferredCurrency: SupportedCurrency
    """Recent transactions (requires auth)"""
    transactions(limit: Int, offset: Int): [Transaction!]!
    """Active vaults belonging to this user"""
    vaults: [Vault!]!
  }

  type KYCDocument {
    id: ID!
    userId: ID!
    type: String!
    status: KYCStatus!
    rejectionReason: String
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type KYCInfo {
    level: KYCLevel!
    status: KYCStatus!
    documents: [KYCDocument!]!
    dailyLimit: String!
    remainingDailyLimit: String!
  }

  # ---------------------------------------------------------------------------
  # Transaction types (multi-currency aware)
  # ---------------------------------------------------------------------------

  type Transaction {
    id: ID!
    referenceNumber: String!
    providerReference: String
    type: TransactionType!
    """Amount in the transaction's original currency"""
    amount: String!
    """Currency of the amount field"""
    currency: SupportedCurrency!
    """Amount converted to USD base (for accounting)"""
    amountUsd: String
    """FX rate applied at time of transaction"""
    fxRate: String
    """FX fee charged for currency conversion"""
    fxFee: String
    """Currency of the FX fee"""
    fxFeeCurrency: SupportedCurrency
    """Platform fee amount"""
    fee: String
    """Total amount including fees"""
    totalAmount: String
    phoneNumber: String!
    provider: String!
    stellarAddress: String
    status: TransactionStatus!
    tags: [String!]!
    retryCount: Int
    createdAt: DateTime!
    updatedAt: DateTime
    completedAt: DateTime
    """Job progress for pending transactions (0–100)"""
    jobProgress: Float
    """Linked dispute, if any"""
    dispute: Dispute
    """Settlement currency (may differ from transaction currency)"""
    settlementCurrency: SupportedCurrency
    """Amount in settlement currency"""
    settlementAmount: String
  }

  type DepositResult {
    transactionId: ID!
    referenceNumber: String!
    status: TransactionStatus!
    jobId: String!
    """Estimated converted amount in target currency"""
    estimatedAmount: String
    """FX rate used for estimate"""
    estimatedFxRate: String
  }

  type WithdrawResult {
    transactionId: ID!
    referenceNumber: String!
    status: TransactionStatus!
    jobId: String!
  }

  type TransactionConnection {
    edges: [TransactionEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type TransactionEdge {
    node: Transaction!
    cursor: String!
  }

  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
  }

  # ---------------------------------------------------------------------------
  # Vault types
  # ---------------------------------------------------------------------------

  type Vault {
    id: ID!
    userId: ID!
    name: String!
    description: String
    balance: String!
    """Currency of the vault balance"""
    currency: SupportedCurrency!
    targetAmount: String
    isActive: Boolean!
    createdAt: DateTime!
    updatedAt: DateTime!
    transactions(limit: Int, offset: Int): [VaultTransaction!]!
  }

  type VaultTransaction {
    id: ID!
    vaultId: ID!
    type: VaultTransactionType!
    amount: String!
    currency: SupportedCurrency!
    description: String
    createdAt: DateTime!
  }

  # ---------------------------------------------------------------------------
  # Merchant types
  # ---------------------------------------------------------------------------

  type Merchant {
    id: ID!
    name: String!
    email: String!
    phoneNumber: String!
    businessName: String
    businessType: String
    country: String!
    status: MerchantStatus!
    kycStatus: KYCStatus!
    createdAt: DateTime!
    updatedAt: DateTime!
    """Currencies this merchant can accept"""
    acceptedCurrencies: [SupportedCurrency!]!
    metadata: JSON
  }

  # ---------------------------------------------------------------------------
  # Dispute types
  # ---------------------------------------------------------------------------

  type DisputeNote {
    id: ID!
    disputeId: ID!
    author: String!
    note: String!
    createdAt: DateTime!
  }

  type Dispute {
    id: ID!
    transactionId: ID!
    reason: String!
    status: DisputeStatus!
    assignedTo: String
    resolution: String
    reportedBy: String
    createdAt: DateTime!
    updatedAt: DateTime!
    notes: [DisputeNote!]!
  }

  type DisputeReportSummaryRow {
    status: String!
    count: String!
    avgResolutionHours: String
  }

  type DisputeReportTotals {
    total: Int!
    open: Int!
    investigating: Int!
    resolved: Int!
    rejected: Int!
    reversed: Int!
    upheld: Int!
  }

  type DisputeReport {
    generatedAt: String!
    summary: [DisputeReportSummaryRow!]!
    totals: DisputeReportTotals!
  }

  # ---------------------------------------------------------------------------
  # Bulk import types
  # ---------------------------------------------------------------------------

  type BulkImportJobProgress {
    total: Int!
    processed: Int!
    succeeded: Int!
    failed: Int!
  }

  type BulkImportJobError {
    row: Int!
    error: String!
  }

  type BulkImportJob {
    jobId: ID!
    status: String!
    progress: BulkImportJobProgress!
    errors: [BulkImportJobError!]!
    createdAt: DateTime!
    completedAt: DateTime
  }

  # ---------------------------------------------------------------------------
  # Currency / FX types
  # ---------------------------------------------------------------------------

  type ExchangeRate {
    fromCurrency: SupportedCurrency!
    toCurrency: SupportedCurrency!
    rate: String!
    """Rate including platform buffer/spread"""
    bufferedRate: String
    """Buffer percent applied"""
    bufferPercent: String
    fetchedAt: DateTime!
    isStale: Boolean!
    usingFallback: Boolean!
  }

  type ExchangeRateStatus {
    cachePopulated: Boolean!
    isStale: Boolean!
    lastUpdated: DateTime
    usingFallback: Boolean!
    supportedCurrencies: [SupportedCurrency!]!
  }

  type CurrencyConversionResult {
    fromCurrency: SupportedCurrency!
    toCurrency: SupportedCurrency!
    originalAmount: String!
    convertedAmount: String!
    rate: String!
    fxFee: String!
    fxFeePercent: String!
    netAmount: String!
    fetchedAt: DateTime!
  }

  type SupportedCurrencyInfo {
    code: SupportedCurrency!
    name: String!
    symbol: String!
    minorUnits: Int!
    minValue: String!
    maxValue: String!
  }

  # ---------------------------------------------------------------------------
  # Stats & reporting
  # ---------------------------------------------------------------------------

  type TransactionStats {
    totalCount: Int!
    totalVolumeUsd: String!
    byStatus: [StatusCount!]!
    byCurrency: [CurrencyVolume!]!
    byProvider: [ProviderCount!]!
    periodStart: DateTime
    periodEnd: DateTime
  }

  type StatusCount {
    status: String!
    count: Int!
  }

  type CurrencyVolume {
    currency: SupportedCurrency!
    count: Int!
    totalAmount: String!
    totalAmountUsd: String!
  }

  type ProviderCount {
    provider: String!
    count: Int!
    totalAmountUsd: String!
  }

  type MultiCurrencyReport {
    generatedAt: DateTime!
    baseCurrency: SupportedCurrency!
    totalVolumeUsd: String!
    fxFeesCollectedUsd: String!
    byOriginalCurrency: [CurrencyVolume!]!
    bySettlementCurrency: [CurrencyVolume!]!
    fxFeeByCurrency: [CurrencyFxFee!]!
  }

  type CurrencyFxFee {
    currency: SupportedCurrency!
    totalFxFee: String!
    totalFxFeeUsd: String!
    transactionCount: Int!
  }

  # ---------------------------------------------------------------------------
  # Subscription event types
  # ---------------------------------------------------------------------------

  type ExchangeRateUpdatedPayload {
    currency: SupportedCurrency!
    rate: String!
    previousRate: String
    updatedAt: DateTime!
  }

  # ---------------------------------------------------------------------------
  # Inputs
  # ---------------------------------------------------------------------------

  input DepositInput {
    amount: String!
    currency: SupportedCurrency
    phoneNumber: String!
    provider: String!
    stellarAddress: String!
  }

  input WithdrawInput {
    amount: String!
    currency: SupportedCurrency
    phoneNumber: String!
    provider: String!
    stellarAddress: String!
  }

  input OpenDisputeInput {
    transactionId: ID!
    reason: String!
    reportedBy: String
  }

  input UpdateDisputeStatusInput {
    disputeId: ID!
    status: DisputeStatus!
    resolution: String
    assignedTo: String
  }

  input AssignDisputeInput {
    disputeId: ID!
    agentName: String!
  }

  input AddDisputeNoteInput {
    disputeId: ID!
    author: String!
    note: String!
  }

  input DisputeReportFilterInput {
    from: String
    to: String
    assignedTo: String
  }

  input TransactionFilterInput {
    status: TransactionStatus
    type: TransactionType
    currency: SupportedCurrency
    provider: String
    tags: [String!]
    fromDate: DateTime
    toDate: DateTime
    minAmount: Float
    maxAmount: Float
  }

  input ConvertCurrencyInput {
    amount: String!
    fromCurrency: SupportedCurrency!
    toCurrency: SupportedCurrency!
    provider: String
    direction: CurrencyConversionDirection
  }

  input MultiCurrencyReportFilterInput {
    from: DateTime
    to: DateTime
    currencies: [SupportedCurrency!]
  }

  input TransactionStatsFilterInput {
    from: DateTime
    to: DateTime
  }

  # ---------------------------------------------------------------------------
  # Root types
  # ---------------------------------------------------------------------------

  type Query {
    # Auth / user
    me: User

    # Transactions
    transaction(id: ID!): Transaction
    transactions(
      limit: Int
      offset: Int
      filter: TransactionFilterInput
      providerReference: String
    ): TransactionConnection!
    transactionByReferenceNumber(referenceNumber: String!): Transaction
    transactionsByTags(tags: [String!]!): [Transaction!]!
    transactionStats(filter: TransactionStatsFilterInput): TransactionStats!

    # Disputes
    dispute(id: ID!): Dispute
    disputeReport(filter: DisputeReportFilterInput): DisputeReport!

    # Bulk import
    bulkImportJob(id: ID!): BulkImportJob

    # Currency / FX
    exchangeRate(
      fromCurrency: SupportedCurrency!
      toCurrency: SupportedCurrency!
      provider: String
    ): ExchangeRate!
    exchangeRates(baseCurrency: SupportedCurrency): [ExchangeRate!]!
    exchangeRateStatus: ExchangeRateStatus!
    supportedCurrencies: [SupportedCurrencyInfo!]!
    convertCurrency(input: ConvertCurrencyInput!): CurrencyConversionResult!

    # Vaults
    vault(id: ID!): Vault
    vaults: [Vault!]!

    # Merchants (admin)
    merchant(id: ID!): Merchant
    merchants(limit: Int, offset: Int, status: MerchantStatus): [Merchant!]!

    # Reporting
    multiCurrencyReport(filter: MultiCurrencyReportFilterInput): MultiCurrencyReport!
  }

  type Mutation {
    # Transactions
    deposit(input: DepositInput!): DepositResult!
    withdraw(input: WithdrawInput!): WithdrawResult!

    # Disputes
    openDispute(input: OpenDisputeInput!): Dispute!
    updateDisputeStatus(input: UpdateDisputeStatusInput!): Dispute!
    assignDispute(input: AssignDisputeInput!): Dispute!
    addDisputeNote(input: AddDisputeNoteInput!): DisputeNote!

    # Currency
    convertCurrency(input: ConvertCurrencyInput!): CurrencyConversionResult!
    refreshExchangeRates: ExchangeRateStatus!
  }

  type Subscription {
    # Transaction events
    transactionCreated: Transaction!
    transactionUpdated(id: ID): Transaction!
    transactionCompleted: Transaction!
    transactionFailed: Transaction!

    # Dispute events
    disputeCreated: Dispute!
    disputeUpdated(id: ID): Dispute!
    disputeNoteAdded(disputeId: ID): DisputeNote!

    # Bulk import events
    bulkImportJobUpdated(jobId: ID!): BulkImportJob!

    # FX events
    exchangeRateUpdated(currency: SupportedCurrency): ExchangeRateUpdatedPayload!
  }
`;
