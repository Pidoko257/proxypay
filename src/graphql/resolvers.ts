/* eslint-disable @typescript-eslint/no-explicit-any */
import { GraphQLError } from "graphql";
import type {
  Dispute,
  DisputeNote,
  DisputeStatus,
  DisputeWithNotes,
  ReportFilter,
} from "../models/dispute";
import type { GraphQLContext } from "./context";
import { requireAuth, requireRole } from "./context";
import { mapTransactionRow, type MappedTransaction } from "./transactionMapper";
import { TransactionStatus } from "../models/transaction";
import { createSubscriptionResolvers } from "./subscriptionResolvers";
import { getRedisPubSub } from "./redisPubSub";
import {
  SubscriptionChannels,
  type TransactionCreatedPayload,
  type DisputeCreatedPayload,
  type DisputeUpdatedPayload,
  type DisputeNoteAddedPayload,
} from "./subscriptions";
import {
  convertWithFee,
  getExchangeRate,
  getAllExchangeRates,
  getSupportedCurrencies,
  type FullConversionResult,
  type ExchangeRateInfo,
} from "../services/fxService";
import { currencyService, BASE_CURRENCY, type SupportedCurrency } from "../services/currency";
import { queryRead } from "../config/database";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_DISPUTE_STATUSES: DisputeStatus[] = [
  "open",
  "investigating",
  "resolved",
  "rejected",
  "reversed",
  "upheld",
];

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function formatNote(n: DisputeNote) {
  return {
    id: n.id,
    disputeId: n.disputeId,
    author: n.author,
    note: n.note,
    createdAt:
      n.createdAt instanceof Date
        ? n.createdAt.toISOString()
        : String(n.createdAt),
  };
}

function formatDispute(d: Dispute | DisputeWithNotes) {
  const notes =
    "notes" in d && Array.isArray(d.notes) ? d.notes.map(formatNote) : [];
  return {
    id: d.id,
    transactionId: d.transactionId,
    reason: d.reason,
    status: d.status,
    assignedTo: d.assignedTo,
    resolution: d.resolution,
    reportedBy: d.reportedBy,
    createdAt:
      d.createdAt instanceof Date
        ? d.createdAt.toISOString()
        : String(d.createdAt),
    updatedAt:
      d.updatedAt instanceof Date
        ? d.updatedAt.toISOString()
        : String(d.updatedAt),
    notes,
  };
}

function toGraphQLError(err: unknown, fallback: string): GraphQLError {
  const message = err instanceof Error ? err.message : fallback;
  const lower = message.toLowerCase();
  if (lower.includes("not found")) {
    return new GraphQLError(message, { extensions: { code: "NOT_FOUND" } });
  }
  if (lower.includes("already exists")) {
    return new GraphQLError(message, { extensions: { code: "CONFLICT" } });
  }
  if (
    lower.includes("cannot transition") ||
    lower.includes("resolution text") ||
    lower.includes("cannot assign") ||
    lower.includes("only allowed for completed")
  ) {
    return new GraphQLError(message, {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  return new GraphQLError(message, { extensions: { code: "INTERNAL" } });
}

function encodeCursor(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64");
}

// ---------------------------------------------------------------------------
// Query resolvers
// ---------------------------------------------------------------------------

const Query = {
  me: (
    _parent: unknown,
    _args: unknown,
    ctx: GraphQLContext,
  ) => {
    requireAuth(ctx.auth);
    if (!ctx.auth.userId) return null;
    // Use DataLoader to fetch user
    return ctx.loaders.userLoader.load(ctx.auth.userId);
  },

  transaction: async (
    _parent: unknown,
    args: { id: string },
    ctx: GraphQLContext,
  ): Promise<MappedTransaction | null> => {
    requireAuth(ctx.auth);
    return ctx.loaders.transactionLoader.load(args.id);
  },

  transactions: async (
    _parent: unknown,
    args: {
      limit?: number | null;
      offset?: number | null;
      filter?: any;
      providerReference?: string | null;
    },
    ctx: GraphQLContext,
  ) => {
    requireAuth(ctx.auth);
    
    const limit = Math.min(args.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
    const offset = args.offset ?? 0;

    // Build WHERE clause from filter
    const whereClauses: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (args.filter?.status) {
      whereClauses.push(`status = $${paramIndex++}`);
      params.push(args.filter.status);
    }
    if (args.filter?.type) {
      whereClauses.push(`type = $${paramIndex++}`);
      params.push(args.filter.type);
    }
    if (args.filter?.currency) {
      whereClauses.push(`currency = $${paramIndex++}`);
      params.push(args.filter.currency);
    }
    if (args.filter?.provider) {
      whereClauses.push(`provider = $${paramIndex++}`);
      params.push(args.filter.provider);
    }
    if (args.providerReference) {
      whereClauses.push(`provider_reference = $${paramIndex++}`);
      params.push(args.providerReference);
    }
    if (args.filter?.fromDate) {
      whereClauses.push(`created_at >= $${paramIndex++}`);
      params.push(new Date(args.filter.fromDate));
    }
    if (args.filter?.toDate) {
      whereClauses.push(`created_at <= $${paramIndex++}`);
      params.push(new Date(args.filter.toDate));
    }

    const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    params.push(limit, offset);
    const countResult = await queryRead(
      `SELECT COUNT(*) as total FROM transactions ${whereSQL}`,
      params.slice(0, -2),
    );
    const totalCount = parseInt(countResult.rows[0]?.total ?? "0", 10);

    const result = await queryRead(
      `SELECT * FROM transactions ${whereSQL} ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      params,
    );

    const edges = result.rows.map((r: any) => {
      const node = mapTransactionRow(r as unknown as Record<string, unknown>);
      return {
        node,
        cursor: encodeCursor(node.id),
      };
    });

    return {
      edges,
      pageInfo: {
        hasNextPage: offset + limit < totalCount,
        hasPreviousPage: offset > 0,
        startCursor: edges[0]?.cursor ?? null,
        endCursor: edges[edges.length - 1]?.cursor ?? null,
      },
      totalCount,
    };
  },

  transactionByReferenceNumber: async (
    _parent: unknown,
    args: { referenceNumber: string },
    ctx: GraphQLContext,
  ): Promise<MappedTransaction | null> => {
    requireAuth(ctx.auth);
    const row = await ctx.transactionModel.findByReferenceNumber(
      args.referenceNumber,
    );
    if (!row) return null;
    return mapTransactionRow(row as unknown as Record<string, unknown>);
  },

  transactionsByTags: async (
    _parent: unknown,
    args: { tags: string[] },
    ctx: GraphQLContext,
  ): Promise<MappedTransaction[]> => {
    requireAuth(ctx.auth);
    try {
      const rows = await ctx.transactionModel.findByTags(args.tags);
      return rows.map((r) =>
        mapTransactionRow(r as unknown as Record<string, unknown>),
      );
    } catch (err) {
      throw toGraphQLError(err, "Failed to query by tags");
    }
  },

  transactionStats: async (
    _parent: unknown,
    args: { filter?: { from?: string; to?: string } },
    ctx: GraphQLContext,
  ) => {
    requireAuth(ctx.auth);
    requireRole(ctx.auth, "admin", "super-admin", "compliance_officer");

    const whereClauses: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (args.filter?.from) {
      whereClauses.push(`created_at >= $${paramIndex++}`);
      params.push(new Date(args.filter.from));
    }
    if (args.filter?.to) {
      whereClauses.push(`created_at <= $${paramIndex++}`);
      params.push(new Date(args.filter.to));
    }

    const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const [countRes, statusRes, currencyRes, providerRes] = await Promise.all([
      queryRead(`SELECT COUNT(*) as total, SUM(amount_usd::numeric) as volume FROM transactions ${whereSQL}`, params),
      queryRead(`SELECT status, COUNT(*) as count FROM transactions ${whereSQL} GROUP BY status`, params),
      queryRead(`SELECT currency, COUNT(*) as count, SUM(amount::numeric) as total, SUM(amount_usd::numeric) as total_usd FROM transactions ${whereSQL} GROUP BY currency`, params),
      queryRead(`SELECT provider, COUNT(*) as count, SUM(amount_usd::numeric) as total_usd FROM transactions ${whereSQL} GROUP BY provider`, params),
    ]);

    return {
      totalCount: parseInt(countRes.rows[0]?.total ?? "0", 10),
      totalVolumeUsd: countRes.rows[0]?.volume ?? "0",
      byStatus: statusRes.rows.map((r: any) => ({ status: r.status, count: parseInt(r.count, 10) })),
      byCurrency: currencyRes.rows.map((r: any) => ({
        currency: r.currency,
        count: parseInt(r.count, 10),
        totalAmount: r.total ?? "0",
        totalAmountUsd: r.total_usd ?? "0",
      })),
      byProvider: providerRes.rows.map((r: any) => ({
        provider: r.provider,
        count: parseInt(r.count, 10),
        totalAmountUsd: r.total_usd ?? "0",
      })),
      periodStart: args.filter?.from ? new Date(args.filter.from).toISOString() : null,
      periodEnd: args.filter?.to ? new Date(args.filter.to).toISOString() : null,
    };
  },

  dispute: async (
    _parent: unknown,
    args: { id: string },
    ctx: GraphQLContext,
  ) => {
    requireAuth(ctx.auth);
    try {
      const d = await ctx.disputeService.getDispute(args.id);
      return formatDispute(d);
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found")) {
        return null;
      }
      throw toGraphQLError(err, "Failed to fetch dispute");
    }
  },

  disputeReport: async (
    _parent: unknown,
    args: {
      filter?: {
        from?: string | null;
        to?: string | null;
        assignedTo?: string | null;
      } | null;
    },
    ctx: GraphQLContext,
  ) => {
    requireAuth(ctx.auth);
    requireRole(ctx.auth, "admin", "super-admin", "support", "compliance_officer");

    const filter: ReportFilter = {};
    const f = args.filter;
    if (f?.from) {
      const d = new Date(f.from);
      if (isNaN(d.getTime())) {
        throw new GraphQLError('Invalid "from" date', {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      filter.from = d;
    }
    if (f?.to) {
      const d = new Date(f.to);
      if (isNaN(d.getTime())) {
        throw new GraphQLError('Invalid "to" date', {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      filter.to = d;
    }
    if (f?.assignedTo) filter.assignedTo = f.assignedTo;

    const r = await ctx.disputeService.generateReport(filter);
    return {
      generatedAt: r.generatedAt,
      summary: r.summary.map((s) => ({
        status: s.status,
        count: s.count,
        avgResolutionHours: s.avgResolutionHours,
      })),
      totals: r.totals,
    };
  },

  bulkImportJob: (
    _parent: unknown,
    args: { id: string },
    ctx: GraphQLContext,
  ) => {
    requireAuth(ctx.auth);
    const job = ctx.getBulkImportJob(args.id);
    if (!job) return null;
    return {
      jobId: job.id,
      status: job.status,
      progress: {
        total: job.total,
        processed: job.processed,
        succeeded: job.succeeded,
        failed: job.failed,
      },
      errors: job.errors.map((e) => ({ row: e.row, error: e.error })),
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt?.toISOString() ?? null,
    };
  },

  // Currency / FX queries
  exchangeRate: async (
    _parent: unknown,
    args: {
      fromCurrency: SupportedCurrency;
      toCurrency: SupportedCurrency;
      provider?: string;
    },
  ): Promise<ExchangeRateInfo> => {
    return getExchangeRate(args.fromCurrency, args.toCurrency, args.provider);
  },

  exchangeRates: async (
    _parent: unknown,
    args: { baseCurrency?: SupportedCurrency },
  ) => {
    return getAllExchangeRates(args.baseCurrency);
  },

  exchangeRateStatus: () => {
    const status = currencyService.getStatus();
    return {
      cachePopulated: status.cachePopulated,
      isStale: status.isStale,
      lastUpdated: status.lastUpdated?.toISOString() ?? null,
      usingFallback: status.usingFallback,
      supportedCurrencies: Object.keys(status.rates),
    };
  },

  supportedCurrencies: () => {
    return getSupportedCurrencies();
  },

  convertCurrency: async (
    _parent: unknown,
    args: {
      input: {
        amount: string;
        fromCurrency: SupportedCurrency;
        toCurrency: SupportedCurrency;
        provider?: string;
        direction?: "sell" | "buy";
      };
    },
  ): Promise<FullConversionResult> => {
    const amount = parseFloat(args.input.amount);
    if (isNaN(amount) || amount < 0) {
      throw new GraphQLError("Invalid amount", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    return convertWithFee(
      amount,
      args.input.fromCurrency,
      args.input.toCurrency,
      args.input.provider,
      args.input.direction ?? "sell",
    );
  },

  vault: async (_parent: unknown, args: { id: string }, ctx: GraphQLContext) => {
    requireAuth(ctx.auth);
    return ctx.loaders.vaultLoader.load(args.id);
  },

  vaults: async (_parent: unknown, _args: unknown, ctx: GraphQLContext) => {
    requireAuth(ctx.auth);
    if (!ctx.auth.userId) return [];
    return ctx.loaders.vaultsByUserLoader.load(ctx.auth.userId);
  },

  merchant: async (_parent: unknown, args: { id: string }, ctx: GraphQLContext) => {
    requireAuth(ctx.auth);
    requireRole(ctx.auth, "admin", "super-admin");
    
    const result = await queryRead(
      `SELECT * FROM merchants WHERE id = $1`,
      [args.id],
    );
    
    if (result.rows.length === 0) return null;
    
    const row = result.rows[0];
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      phoneNumber: row.phone_number,
      businessName: row.business_name,
      businessType: row.business_type,
      country: row.country,
      status: row.status,
      kycStatus: row.kyc_status,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      acceptedCurrencies: row.accepted_currencies ?? ["USD"],
      metadata: row.metadata ?? {},
    };
  },

  merchants: async (
    _parent: unknown,
    args: { limit?: number; offset?: number; status?: string },
    ctx: GraphQLContext,
  ) => {
    requireAuth(ctx.auth);
    requireRole(ctx.auth, "admin", "super-admin");

    const limit = Math.min(args.limit ?? 50, 100);
    const offset = args.offset ?? 0;
    
    let query = `SELECT * FROM merchants`;
    const params: any[] = [];
    
    if (args.status) {
      query += ` WHERE status = $1`;
      params.push(args.status);
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    
    const result = await queryRead(query, params);
    
    return result.rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      phoneNumber: row.phone_number,
      businessName: row.business_name,
      businessType: row.business_type,
      country: row.country,
      status: row.status,
      kycStatus: row.kyc_status,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      acceptedCurrencies: row.accepted_currencies ?? ["USD"],
      metadata: row.metadata ?? {},
    }));
  },

  multiCurrencyReport: async (
    _parent: unknown,
    args: {
      filter?: {
        from?: string;
        to?: string;
        currencies?: SupportedCurrency[];
      };
    },
    ctx: GraphQLContext,
  ) => {
    requireAuth(ctx.auth);
    requireRole(ctx.auth, "admin", "super-admin", "compliance_officer");

    const whereClauses: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (args.filter?.from) {
      whereClauses.push(`created_at >= $${paramIndex++}`);
      params.push(new Date(args.filter.from));
    }
    if (args.filter?.to) {
      whereClauses.push(`created_at <= $${paramIndex++}`);
      params.push(new Date(args.filter.to));
    }
    if (args.filter?.currencies && args.filter.currencies.length > 0) {
      whereClauses.push(`currency = ANY($${paramIndex++})`);
      params.push(args.filter.currencies);
    }

    const whereSQL =
      whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const [volumeRes, fxFeeRes, origCurrRes, settleCurrRes] = await Promise.all([
      queryRead(
        `SELECT SUM(amount_usd::numeric) as total_usd, SUM(fx_fee_usd::numeric) as fx_fees FROM transactions ${whereSQL}`,
        params,
      ),
      queryRead(
        `SELECT currency as fx_fee_currency, SUM(fx_fee::numeric) as total_fx_fee, SUM(fx_fee_usd::numeric) as total_fx_fee_usd, COUNT(*) as count FROM transactions ${whereSQL} AND fx_fee IS NOT NULL GROUP BY currency`,
        params,
      ),
      queryRead(
        `SELECT currency, COUNT(*) as count, SUM(amount::numeric) as total, SUM(amount_usd::numeric) as total_usd FROM transactions ${whereSQL} GROUP BY currency`,
        params,
      ),
      queryRead(
        `SELECT settlement_currency, COUNT(*) as count, SUM(settlement_amount::numeric) as total, SUM(amount_usd::numeric) as total_usd FROM transactions ${whereSQL} AND settlement_currency IS NOT NULL GROUP BY settlement_currency`,
        params,
      ),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      baseCurrency: BASE_CURRENCY,
      totalVolumeUsd: volumeRes.rows[0]?.total_usd ?? "0",
      fxFeesCollectedUsd: volumeRes.rows[0]?.fx_fees ?? "0",
      byOriginalCurrency: origCurrRes.rows.map((r: any) => ({
        currency: r.currency,
        count: parseInt(r.count, 10),
        totalAmount: r.total ?? "0",
        totalAmountUsd: r.total_usd ?? "0",
      })),
      bySettlementCurrency: settleCurrRes.rows.map((r: any) => ({
        currency: r.settlement_currency,
        count: parseInt(r.count, 10),
        totalAmount: r.total ?? "0",
        totalAmountUsd: r.total_usd ?? "0",
      })),
      fxFeeByCurrency: fxFeeRes.rows.map((r: any) => ({
        currency: r.fx_fee_currency,
        totalFxFee: r.total_fx_fee ?? "0",
        totalFxFeeUsd: r.total_fx_fee_usd ?? "0",
        transactionCount: parseInt(r.count, 10),
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Mutation resolvers
// ---------------------------------------------------------------------------

const Mutation = {
  deposit: async (
    _parent: unknown,
    args: {
      input: {
        amount: string;
        currency?: SupportedCurrency;
        phoneNumber: string;
        provider: string;
        stellarAddress: string;
      };
    },
    ctx: GraphQLContext,
  ) => {
    requireAuth(ctx.auth);
    
    const { amount, phoneNumber, stellarAddress } = args.input;
    const currency = args.input.currency ?? BASE_CURRENCY;
    const provider = args.input.provider?.toLowerCase();

    try {
      return await ctx.lockManager.withLock(
        ctx.LockKeys.phoneNumber(phoneNumber),
        async () => {
          // Convert to USD for internal accounting if needed
          let amountUsd = amount;
          let fxRate = "1.0";
          let fxFee = "0";
          
          if (currency !== BASE_CURRENCY) {
            const conversion = await convertWithFee(
              parseFloat(amount),
              currency,
              BASE_CURRENCY,
              provider,
              "sell",
            );
            amountUsd = conversion.netAmountStr;
            fxRate = conversion.rateStr;
            fxFee = conversion.fxFeeStr;
          }

          const transaction = await ctx.transactionModel.create({
            type: "deposit",
            amount,
            currency,
            amountUsd,
            fxRate,
            fxFee,
            fxFeeCurrency: currency,
            phoneNumber,
            provider,
            stellarAddress,
            status: TransactionStatus.Pending,
            tags: [],
          });
          
          const job = await ctx.addTransactionJob({
            transactionId: transaction.id,
            type: "deposit",
            amount,
            currency,
            phoneNumber,
            provider,
            stellarAddress,
          });
          
          const mapped = mapTransactionRow(
            transaction as unknown as Record<string, unknown>,
          );

          // Publish transaction created event
          const createdPayload: TransactionCreatedPayload = {
            id: mapped.id,
            referenceNumber: mapped.referenceNumber,
            type: "deposit",
            amount: String(mapped.amount),
            phoneNumber: mapped.phoneNumber,
            provider: mapped.provider,
            stellarAddress: mapped.stellarAddress,
            status: "pending",
            tags: mapped.tags,
            createdAt: mapped.createdAt,
          };
          ctx.pubsub.publish(
            SubscriptionChannels.TRANSACTION_CREATED,
            createdPayload,
          );

          return {
            transactionId: mapped.id,
            referenceNumber: mapped.referenceNumber,
            status: "pending",
            jobId: String(job.id),
            estimatedAmount: amountUsd,
            estimatedFxRate: fxRate,
          };
        },
        15000,
      );
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes("Unable to acquire lock")
      ) {
        throw new GraphQLError(
          "Transaction already in progress for this phone number",
          { extensions: { code: "CONFLICT" } },
        );
      }
      throw toGraphQLError(err, "Transaction failed");
    }
  },

  withdraw: async (
    _parent: unknown,
    args: {
      input: {
        amount: string;
        currency?: SupportedCurrency;
        phoneNumber: string;
        provider: string;
        stellarAddress: string;
      };
    },
    ctx: GraphQLContext,
  ) => {
    requireAuth(ctx.auth);
    
    const { amount, phoneNumber, provider, stellarAddress } = args.input;
    const currency = args.input.currency ?? BASE_CURRENCY;
    
    try {
      let amountUsd = amount;
      let fxRate = "1.0";
      let fxFee = "0";

      if (currency !== BASE_CURRENCY) {
        const conversion = await convertWithFee(
          parseFloat(amount),
          BASE_CURRENCY,
          currency,
          provider,
          "buy",
        );
        amountUsd = amount;
        fxRate = conversion.rateStr;
        fxFee = conversion.fxFeeStr;
      }

      const transaction = await ctx.transactionModel.create({
        type: "withdraw",
        amount,
        currency,
        amountUsd,
        fxRate,
        fxFee,
        fxFeeCurrency: currency,
        phoneNumber,
        provider,
        stellarAddress,
        status: TransactionStatus.Pending,
        tags: [],
      });
      
      const job = await ctx.addTransactionJob({
        transactionId: transaction.id,
        type: "withdraw",
        amount,
        currency,
        phoneNumber,
        provider,
        stellarAddress,
      });
      
      const mapped = mapTransactionRow(
        transaction as unknown as Record<string, unknown>,
      );

      // Publish transaction created event
      const createdPayload: TransactionCreatedPayload = {
        id: mapped.id,
        referenceNumber: mapped.referenceNumber,
        type: "withdraw",
        amount: String(mapped.amount),
        phoneNumber: mapped.phoneNumber,
        provider: mapped.provider,
        stellarAddress: mapped.stellarAddress,
        status: "pending",
        tags: mapped.tags,
        createdAt: mapped.createdAt,
      };
      ctx.pubsub.publish(
        SubscriptionChannels.TRANSACTION_CREATED,
        createdPayload,
      );

      return {
        transactionId: mapped.id,
        referenceNumber: mapped.referenceNumber,
        status: "pending",
        jobId: String(job.id),
      };
    } catch (err) {
      throw toGraphQLError(err, "Transaction failed");
    }
  },

  openDispute: async (
    _parent: unknown,
    args: {
      input: {
        transactionId: string;
        reason: string;
        reportedBy?: string | null;
      };
    },
    ctx: GraphQLContext,
  ) => {
    requireAuth(ctx.auth);
    
    const { transactionId, reason, reportedBy } = args.input;
    if (!reason?.trim()) {
      throw new GraphQLError('Field "reason" is required', {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    try {
      const d = await ctx.disputeService.openDispute(
        transactionId,
        reason.trim(),
        reportedBy ?? undefined,
      );

      // Publish dispute created event
      const createdPayload: DisputeCreatedPayload = {
        id: d.id,
        transactionId: d.transactionId,
        reason: d.reason,
        status: d.status,
        reportedBy: d.reportedBy,
        createdAt: d.createdAt.toISOString(),
      };
      ctx.pubsub.publish(
        SubscriptionChannels.DISPUTE_CREATED,
        createdPayload,
      );

      return formatDispute(d);
    } catch (err) {
      throw toGraphQLError(err, "Failed to open dispute");
    }
  },

  updateDisputeStatus: async (
    _parent: unknown,
    args: {
      input: {
        disputeId: string;
        status: string;
        resolution?: string | null;
        assignedTo?: string | null;
      };
    },
    ctx: GraphQLContext,
  ) => {
    requireAuth(ctx.auth);
    requireRole(ctx.auth, "admin", "super-admin", "support");
    
    const { disputeId, status, resolution, assignedTo } = args.input;
    if (!VALID_DISPUTE_STATUSES.includes(status as DisputeStatus)) {
      throw new GraphQLError(
        `status must be one of: ${VALID_DISPUTE_STATUSES.join(", ")}`,
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    try {
      await ctx.disputeService.updateStatus(
        disputeId,
        status as DisputeStatus,
        resolution ?? undefined,
        assignedTo ?? undefined,
      );
      const full = await ctx.disputeService.getDispute(disputeId);

      // Publish dispute updated event
      const updatedPayload: DisputeUpdatedPayload = {
        id: full.id,
        status: full.status,
        assignedTo: full.assignedTo,
        resolution: full.resolution,
        updatedAt: full.updatedAt.toISOString(),
      };
      ctx.pubsub.publish(
        SubscriptionChannels.DISPUTE_UPDATED,
        updatedPayload,
      );

      return formatDispute(full);
    } catch (err) {
      throw toGraphQLError(err, "Failed to update dispute");
    }
  },

  assignDispute: async (
    _parent: unknown,
    args: { input: { disputeId: string; agentName: string } },
    ctx: GraphQLContext,
  ) => {
    requireAuth(ctx.auth);
    requireRole(ctx.auth, "admin", "super-admin", "support");
    
    const { disputeId, agentName } = args.input;
    if (!agentName?.trim()) {
      throw new GraphQLError('Field "agentName" is required', {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    try {
      await ctx.disputeService.assignToAgent(disputeId, agentName.trim());
      const full = await ctx.disputeService.getDispute(disputeId);

      // Publish dispute updated event
      const updatedPayload: DisputeUpdatedPayload = {
        id: full.id,
        status: full.status,
        assignedTo: full.assignedTo,
        resolution: full.resolution,
        updatedAt: full.updatedAt.toISOString(),
      };
      ctx.pubsub.publish(
        SubscriptionChannels.DISPUTE_UPDATED,
        updatedPayload,
      );

      return formatDispute(full);
    } catch (err) {
      throw toGraphQLError(err, "Failed to assign dispute");
    }
  },

  addDisputeNote: async (
    _parent: unknown,
    args: {
      input: { disputeId: string; author: string; note: string };
    },
    ctx: GraphQLContext,
  ) => {
    requireAuth(ctx.auth);
    
    const { disputeId, author, note } = args.input;
    if (!author?.trim()) {
      throw new GraphQLError('Field "author" is required', {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    if (!note?.trim()) {
      throw new GraphQLError('Field "note" is required', {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    try {
      const created = await ctx.disputeService.addNote(
        disputeId,
        author.trim(),
        note.trim(),
      );

      // Publish dispute note added event
      const notePayload: DisputeNoteAddedPayload = {
        id: created.id,
        disputeId: created.disputeId,
        author: created.author,
        note: created.note,
        createdAt: created.createdAt.toISOString(),
      };
      ctx.pubsub.publish(
        SubscriptionChannels.DISPUTE_NOTE_ADDED,
        notePayload,
      );

      return formatNote(created);
    } catch (err) {
      throw toGraphQLError(err, "Failed to add note");
    }
  },

  convertCurrency: async (
    _parent: unknown,
    args: {
      input: {
        amount: string;
        fromCurrency: SupportedCurrency;
        toCurrency: SupportedCurrency;
        provider?: string;
        direction?: "sell" | "buy";
      };
    },
    ctx: GraphQLContext,
  ): Promise<FullConversionResult> => {
    requireAuth(ctx.auth);
    
    const amount = parseFloat(args.input.amount);
    if (isNaN(amount) || amount < 0) {
      throw new GraphQLError("Invalid amount", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    return convertWithFee(
      amount,
      args.input.fromCurrency,
      args.input.toCurrency,
      args.input.provider,
      args.input.direction ?? "sell",
    );
  },

  refreshExchangeRates: async (
    _parent: unknown,
    _args: unknown,
    ctx: GraphQLContext,
  ) => {
    requireAuth(ctx.auth);
    requireRole(ctx.auth, "admin", "super-admin");
    
    // Force a refresh of exchange rates
    await currencyService["fetchRates"]();
    
    const status = currencyService.getStatus();
    return {
      cachePopulated: status.cachePopulated,
      isStale: status.isStale,
      lastUpdated: status.lastUpdated?.toISOString() ?? null,
      usingFallback: status.usingFallback,
      supportedCurrencies: Object.keys(status.rates),
    };
  },
};

// ---------------------------------------------------------------------------
// Field resolvers
// ---------------------------------------------------------------------------

const Transaction = {
  jobProgress: async (
    parent: MappedTransaction,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<number | null> => {
    if (parent.status !== "pending") return null;
    const p = await ctx.getJobProgress(parent.id);
    return p;
  },

  dispute: async (
    parent: MappedTransaction,
    _args: unknown,
    ctx: GraphQLContext,
  ) => {
    const dispute = await ctx.loaders.disputeByTransactionLoader.load(parent.id);
    return dispute ? formatDispute(dispute) : null;
  },
};

const User = {
  transactions: async (
    parent: { id: string },
    args: { limit?: number; offset?: number },
    ctx: GraphQLContext,
  ) => {
    requireAuth(ctx.auth);
    
    // Use DataLoader for recent transactions
    const recent = await ctx.loaders.transactionsByUserLoader.load(parent.id);
    
    const limit = args.limit ?? 50;
    const offset = args.offset ?? 0;
    
    return recent.slice(offset, offset + limit);
  },

  vaults: async (
    parent: { id: string },
    _args: unknown,
    ctx: GraphQLContext,
  ) => {
    requireAuth(ctx.auth);
    return ctx.loaders.vaultsByUserLoader.load(parent.id);
  },
};

const Vault = {
  transactions: async (
    parent: { id: string },
    args: { limit?: number; offset?: number },
    ctx: GraphQLContext,
  ) => {
    requireAuth(ctx.auth);
    
    const limit = args.limit ?? 50;
    const offset = args.offset ?? 0;
    
    const result = await queryRead(
      `SELECT id, vault_id, type, amount::text, currency, description, created_at
       FROM vault_transactions
       WHERE vault_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [parent.id, limit, offset],
    );
    
    return result.rows.map((r: any) => ({
      id: r.id,
      vaultId: r.vault_id,
      type: r.type,
      amount: r.amount,
      currency: r.currency ?? BASE_CURRENCY,
      description: r.description,
      createdAt: r.created_at.toISOString(),
    }));
  },
};

// ---------------------------------------------------------------------------
// Export combined resolvers
// ---------------------------------------------------------------------------

export const resolvers = {
  Query,
  Mutation,
  Transaction,
  User,
  Vault,
};

// Subscription resolvers backed by the Redis pubsub singleton
export const subscriptionResolvers = createSubscriptionResolvers(
  getRedisPubSub(),
);
