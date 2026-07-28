/**
 * GraphQL DataLoaders
 *
 * Batch-loads related entities to avoid N+1 query problems. Each request
 * gets its own DataLoader instances (created in context.ts) so caches are
 * scoped per HTTP request and never leak data between users.
 *
 * Pattern: collect all IDs requested in a single tick, fire one SQL query,
 * return results mapped back by ID.
 */

import DataLoader from "dataloader";
import { queryRead } from "../config/database";
import type { User } from "../models/users";
import type { Dispute } from "../models/dispute";
import type { Vault } from "../models/vault";
import { mapTransactionRow } from "./transactionMapper";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Preserve order: DataLoader requires the result array to be in the same
 * order as the keys array.
 */
function orderByKeys<T extends { id: string }>(
  keys: readonly string[],
  rows: T[],
): (T | null)[] {
  const map = new Map(rows.map((r) => [r.id, r]));
  return keys.map((k) => map.get(k) ?? null);
}

// ---------------------------------------------------------------------------
// Transaction DataLoader
// ---------------------------------------------------------------------------

export type TransactionLoaderType = DataLoader<
  string,
  ReturnType<typeof mapTransactionRow> | null
>;

export function createTransactionLoader(): TransactionLoaderType {
  return new DataLoader<string, ReturnType<typeof mapTransactionRow> | null>(
    async (ids) => {
      const result = await queryRead(
        `SELECT * FROM transactions WHERE id = ANY($1::uuid[])`,
        [ids as string[]],
      );
      const mapped = result.rows.map((r) =>
        mapTransactionRow(r as unknown as Record<string, unknown>),
      );
      // orderByKeys expects { id: string }
      const byId = new Map(mapped.map((t) => [t.id, t]));
      return ids.map((id) => byId.get(id) ?? null);
    },
    { cache: true },
  );
}

// ---------------------------------------------------------------------------
// User DataLoader
// ---------------------------------------------------------------------------

export type UserLoaderType = DataLoader<string, User | null>;

export function createUserLoader(): UserLoaderType {
  return new DataLoader<string, User | null>(
    async (ids) => {
      const result = await queryRead(
        `SELECT id, phone_number, kyc_level, email, display_name, status,
                preferred_language, created_at, updated_at, token_version,
                sms_opt_out, mandatory_2fa_withdrawals
         FROM users
         WHERE id = ANY($1::uuid[])`,
        [ids as string[]],
      );

      const users: User[] = result.rows.map((row) => ({
        id: row.id,
        phoneNumber: row.phone_number,
        kycLevel: row.kyc_level,
        email: row.email ?? undefined,
        displayName: row.display_name ?? null,
        status: row.status,
        preferredLanguage: row.preferred_language ?? undefined,
        two_factor_secret: null,
        backup_codes: null,
        tokenVersion: row.token_version ?? 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        smsOptOut: row.sms_opt_out ?? false,
        mandatory2FAWithdrawals: row.mandatory_2fa_withdrawals ?? false,
      }));

      return orderByKeys(ids as string[], users) as (User | null)[];
    },
    { cache: true },
  );
}

// ---------------------------------------------------------------------------
// Dispute DataLoader
// ---------------------------------------------------------------------------

export type DisputeLoaderType = DataLoader<string, Dispute | null>;

export function createDisputeLoader(): DisputeLoaderType {
  return new DataLoader<string, Dispute | null>(
    async (ids) => {
      const result = await queryRead(
        `SELECT id, transaction_id, reason, status, assigned_to,
                resolution, reported_by, created_at, updated_at
         FROM disputes
         WHERE id = ANY($1::uuid[])`,
        [ids as string[]],
      );

      const disputes = result.rows.map((row) => ({
        id: row.id,
        transactionId: row.transaction_id,
        reason: row.reason,
        status: row.status,
        assignedTo: row.assigned_to ?? null,
        resolution: row.resolution ?? null,
        reportedBy: row.reported_by ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })) as Dispute[];

      return orderByKeys(ids as string[], disputes) as (Dispute | null)[];
    },
    { cache: true },
  );
}

// ---------------------------------------------------------------------------
// Vault DataLoader
// ---------------------------------------------------------------------------

export type VaultLoaderType = DataLoader<string, Vault | null>;

export function createVaultLoader(): VaultLoaderType {
  return new DataLoader<string, Vault | null>(
    async (ids) => {
      const result = await queryRead(
        `SELECT id, user_id, name, description, balance::text,
                target_amount::text, is_active, created_at, updated_at
         FROM vaults
         WHERE id = ANY($1::uuid[])`,
        [ids as string[]],
      );

      const vaults = result.rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        name: row.name,
        description: row.description ?? undefined,
        balance: row.balance,
        targetAmount: row.target_amount ?? undefined,
        isActive: row.is_active,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })) as Vault[];

      return orderByKeys(ids as string[], vaults) as (Vault | null)[];
    },
    { cache: true },
  );
}

// ---------------------------------------------------------------------------
// Disputes by transaction DataLoader (1-to-1)
// ---------------------------------------------------------------------------

export type DisputeByTransactionLoaderType = DataLoader<
  string,
  Dispute | null
>;

export function createDisputeByTransactionLoader(): DisputeByTransactionLoaderType {
  return new DataLoader<string, Dispute | null>(
    async (transactionIds) => {
      const result = await queryRead(
        `SELECT id, transaction_id, reason, status, assigned_to,
                resolution, reported_by, created_at, updated_at
         FROM disputes
         WHERE transaction_id = ANY($1::uuid[])`,
        [transactionIds as string[]],
      );

      const byTxId = new Map<string, Dispute>();
      for (const row of result.rows) {
        byTxId.set(row.transaction_id, {
          id: row.id,
          transactionId: row.transaction_id,
          reason: row.reason,
          status: row.status,
          assignedTo: row.assigned_to ?? null,
          resolution: row.resolution ?? null,
          reportedBy: row.reported_by ?? null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        } as Dispute);
      }

      return transactionIds.map((id) => byTxId.get(id) ?? null);
    },
    { cache: true },
  );
}

// ---------------------------------------------------------------------------
// Vaults by user DataLoader (1-to-many)
// ---------------------------------------------------------------------------

export type VaultsByUserLoaderType = DataLoader<string, Vault[]>;

export function createVaultsByUserLoader(): VaultsByUserLoaderType {
  return new DataLoader<string, Vault[]>(
    async (userIds) => {
      const result = await queryRead(
        `SELECT id, user_id, name, description, balance::text,
                target_amount::text, is_active, created_at, updated_at
         FROM vaults
         WHERE user_id = ANY($1::uuid[]) AND is_active = true
         ORDER BY created_at ASC`,
        [userIds as string[]],
      );

      const byUserId = new Map<string, Vault[]>();
      for (const id of userIds) byUserId.set(id, []);

      for (const row of result.rows) {
        const vault: Vault = {
          id: row.id,
          userId: row.user_id,
          name: row.name,
          description: row.description ?? undefined,
          balance: row.balance,
          targetAmount: row.target_amount ?? undefined,
          isActive: row.is_active,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
        byUserId.get(row.user_id)?.push(vault);
      }

      return (userIds as string[]).map((id) => byUserId.get(id) ?? []);
    },
    { cache: true },
  );
}

// ---------------------------------------------------------------------------
// Transactions by user DataLoader (1-to-many with limit)
// ---------------------------------------------------------------------------

export type TransactionsByUserLoaderType = DataLoader<
  string,
  ReturnType<typeof mapTransactionRow>[]
>;

export function createTransactionsByUserLoader(): TransactionsByUserLoaderType {
  return new DataLoader<string, ReturnType<typeof mapTransactionRow>[]>(
    async (userIds) => {
      // Fetch up to 50 most recent transactions per user in one query
      const result = await queryRead(
        `SELECT DISTINCT ON (user_id, id) *
         FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
           FROM transactions
           WHERE user_id = ANY($1::uuid[])
         ) sub
         WHERE rn <= 50
         ORDER BY user_id, created_at DESC`,
        [userIds as string[]],
      );

      const byUserId = new Map<string, ReturnType<typeof mapTransactionRow>[]>();
      for (const id of userIds) byUserId.set(id, []);

      for (const row of result.rows) {
        const userId = row.user_id as string;
        const mapped = mapTransactionRow(row as unknown as Record<string, unknown>);
        byUserId.get(userId)?.push(mapped);
      }

      return (userIds as string[]).map((id) => byUserId.get(id) ?? []);
    },
    { cache: true },
  );
}

// ---------------------------------------------------------------------------
// Bundle type
// ---------------------------------------------------------------------------

export interface GraphQLDataLoaders {
  transactionLoader: TransactionLoaderType;
  userLoader: UserLoaderType;
  disputeLoader: DisputeLoaderType;
  vaultLoader: VaultLoaderType;
  disputeByTransactionLoader: DisputeByTransactionLoaderType;
  vaultsByUserLoader: VaultsByUserLoaderType;
  transactionsByUserLoader: TransactionsByUserLoaderType;
}

export function createDataLoaders(): GraphQLDataLoaders {
  return {
    transactionLoader: createTransactionLoader(),
    userLoader: createUserLoader(),
    disputeLoader: createDisputeLoader(),
    vaultLoader: createVaultLoader(),
    disputeByTransactionLoader: createDisputeByTransactionLoader(),
    vaultsByUserLoader: createVaultsByUserLoader(),
    transactionsByUserLoader: createTransactionsByUserLoader(),
  };
}
