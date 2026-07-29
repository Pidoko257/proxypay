import { gql } from "apollo-server-express";

/**
 * Extended GraphQL schema with field-level authorization directives
 * This schema includes Vault and other sensitive types with @auth directives
 */
export const extendedTypeDefs = gql`
  directive @auth(requires: String!, requireOwnership: Boolean) on FIELD_DEFINITION
  directive @mask(strategy: String!, requires: String!) on FIELD_DEFINITION
  directive @requireRole(role: String!) on FIELD_DEFINITION

  type User {
    id: ID!
    subject: String!
  }

  type Transaction {
    id: ID!
    referenceNumber: String!
    providerReference: String! @auth(requires: "VIEW_TRANSACTION_SENSITIVE", requireOwnership: true)
    type: String!
    amount: String!
    phoneNumber: String! @mask(strategy: "PHONE", requires: "VIEW_TRANSACTION_PHONE")
    provider: String!
    stellarAddress: String! @mask(strategy: "STELLAR", requires: "VIEW_VAULT_ADDRESS")
    status: String!
    tags: [String!]!
    retryCount: Int
    createdAt: String!
    jobProgress: Float
  }

  type Vault {
    id: ID!
    userId: ID! @auth(requires: "VIEW_VAULT_SECRETS", requireOwnership: true)
    name: String!
    description: String
    balance: String!
    targetAmount: String
    isActive: Boolean!
    createdAt: String!
    updatedAt: String!
    vaultAddress: String @auth(requires: "VIEW_VAULT_ADDRESS", requireOwnership: true)
    vaultSecret: String @auth(requires: "VIEW_VAULT_SECRETS", requireOwnership: true)
    vaultTransactions: [VaultTransaction!]! @auth(requires: "VIEW_VAULT_ADDRESS", requireOwnership: true)
  }

  type VaultTransaction {
    id: ID!
    vaultId: ID!
    userId: ID!
    type: String!
    amount: String!
    description: String
    referenceId: String
    createdAt: String!
  }

  type VaultQueryResult {
    vaults: [Vault!]!
    totalBalance: String!
  }

  type ProviderKey {
    id: ID!
    providerId: String! @auth(requires: "VIEW_PROVIDER_KEY")
    keyName: String! @auth(requires: "VIEW_PROVIDER_KEY")
    keyValue: String! @auth(requires: "VIEW_PROVIDER_SECRET")
    isActive: Boolean!
    createdAt: String!
    updatedAt: String!
  }

  type DepositResult {
    transactionId: ID!
    referenceNumber: String!
    status: String!
    jobId: String!
  }

  type WithdrawResult {
    transactionId: ID!
    referenceNumber: String!
    status: String!
    jobId: String!
  }

  type DisputeNote {
    id: ID!
    disputeId: ID!
    author: String!
    note: String!
    createdAt: String!
  }

  type Dispute {
    id: ID!
    transactionId: ID!
    reason: String!
    status: String!
    assignedTo: String @requireRole(role: "admin")
    resolution: String @auth(requires: "VIEW_DISPUTE_DETAILS")
    reportedBy: String @auth(requires: "VIEW_DISPUTE_DETAILS", requireOwnership: true)
    createdAt: String!
    updatedAt: String!
    notes: [DisputeNote!]! @auth(requires: "VIEW_DISPUTE_NOTES")
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

  type DisputeReport @requireRole(role: "compliance") {
    generatedAt: String!
    summary: [DisputeReportSummaryRow!]!
    totals: DisputeReportTotals!
  }

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
    createdAt: String!
    completedAt: String
  }

  # Subscription types for real-time updates
  type Subscription {
    # Subscribe to transaction events
    transactionCreated: Transaction!
    transactionUpdated(id: ID): Transaction!
    transactionCompleted: Transaction!
    transactionFailed: Transaction!

    # Subscribe to dispute events
    disputeCreated: Dispute!
    disputeUpdated(id: ID): Dispute!
    disputeNoteAdded(disputeId: ID): DisputeNote!

    # Subscribe to bulk import job events
    bulkImportJobUpdated(jobId: ID!): BulkImportJob!
  }

  input DepositInput {
    amount: String!
    phoneNumber: String!
    provider: String!
    stellarAddress: String!
  }

  input WithdrawInput {
    amount: String!
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
    status: String!
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

  input CreateVaultInput {
    name: String!
    description: String
    targetAmount: String
  }

  input VaultTransferInput {
    vaultId: ID!
    type: String!
    amount: String!
    description: String
  }

  type Query {
    me: User
    transaction(id: ID!): Transaction
    transactions(
      limit: Int
      offset: Int
      providerReference: String
    ): [Transaction!]!
    transactionByReferenceNumber(referenceNumber: String!): Transaction
    transactionsByTags(tags: [String!]!): [Transaction!]!
    
    # Vault queries
    vault(id: ID!): Vault @auth(requires: "VIEW_VAULT_ADDRESS", requireOwnership: true)
    userVaults: [Vault!]! @auth(requires: "VIEW_VAULT_ADDRESS", requireOwnership: true)
    vaultBalance(vaultId: ID!): String @auth(requires: "VIEW_VAULT_ADDRESS", requireOwnership: true)
    
    # Dispute queries
    dispute(id: ID!): Dispute
    disputeReport(filter: DisputeReportFilterInput): DisputeReport!
    bulkImportJob(id: ID!): BulkImportJob
  }

  type Mutation {
    deposit(input: DepositInput!): DepositResult!
    withdraw(input: WithdrawInput!): WithdrawResult!
    openDispute(input: OpenDisputeInput!): Dispute!
    updateDisputeStatus(input: UpdateDisputeStatusInput!): Dispute!
    assignDispute(input: AssignDisputeInput!): Dispute!
    addDisputeNote(input: AddDisputeNoteInput!): DisputeNote!
    
    # Vault mutations
    createVault(input: CreateVaultInput!): Vault! @auth(requires: "VIEW_VAULT_ADDRESS", requireOwnership: true)
    updateVault(id: ID!, name: String, description: String): Vault! @auth(requires: "VIEW_VAULT_ADDRESS", requireOwnership: true)
    deleteVault(id: ID!): Boolean! @auth(requires: "VIEW_VAULT_SECRETS", requireOwnership: true)
    transferToVault(input: VaultTransferInput!): VaultTransaction! @auth(requires: "VIEW_VAULT_ADDRESS", requireOwnership: true)
  }
`;
