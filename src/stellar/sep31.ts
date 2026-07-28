import { Router, Request, Response } from "express";
import { sep31RateLimiter } from "../middleware/rateLimit";
import crypto from "crypto";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { getConfiguredPaymentAsset } from "../services/stellar/assetService";
import  rateLimit from "express-rate-limit";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";
import { z } from "zod";
import { pool } from "../config/database";
import { requireAuth } from "../middleware/auth";

const router = Router();
const transactionModel = new TransactionModel();

// --- SEP-31 Status State Machine ---
// Valid statuses per SEP-31 spec
export enum Sep31Status {
  PendingSender = "pending_sender",
  PendingStellar = "pending_stellar",
  PendingReceiver = "pending_receiver",
  PendingExternal = "pending_external",
  Completed = "completed",
  Error = "error",
}

// Valid status transitions
const VALID_TRANSITIONS: Record<string, string[]> = {
  [Sep31Status.PendingSender]: [Sep31Status.PendingStellar, Sep31Status.Error],
  [Sep31Status.PendingStellar]: [Sep31Status.PendingReceiver, Sep31Status.PendingExternal, Sep31Status.Completed, Sep31Status.Error],
  [Sep31Status.PendingReceiver]: [Sep31Status.PendingExternal, Sep31Status.Completed, Sep31Status.Error],
  [Sep31Status.PendingExternal]: [Sep31Status.Completed, Sep31Status.Error],
  [Sep31Status.Completed]: [],
  [Sep31Status.Error]: [Sep31Status.PendingStellar, Sep31Status.PendingReceiver],
};

function isValidTransition(from: string, to: string): boolean {
  return (VALID_TRANSITIONS[from] || []).includes(to);
}

// Map internal TransactionStatus to SEP-31 status
function mapToSep31Status(status: TransactionStatus, metadata?: Record<string, unknown>): Sep31Status {
  const sep31Meta = (metadata as any)?.sep31;
  if (sep31Meta?.status) return sep31Meta.status as Sep31Status;

  switch (status) {
    case TransactionStatus.Completed: return Sep31Status.Completed;
    case TransactionStatus.Failed: return Sep31Status.Error;
    case TransactionStatus.Cancelled: return Sep31Status.Error;
    default: return Sep31Status.PendingSender;
  }
}

// --- Configuration ---
const SEP31_CONFIG = {
  minAmount: parseFloat(process.env.SEP31_MIN_AMOUNT || "0.1"),
  maxAmount: parseFloat(process.env.SEP31_MAX_AMOUNT || "1000000"),
  feeFixed: parseFloat(process.env.SEP31_FEE_FIXED || "1.00"),
  feePercent: parseFloat(process.env.SEP31_FEE_PERCENT || "0.5"),
  statusEta: parseInt(process.env.SEP31_STATUS_ETA || "600", 10),
  get receivingAccount(): string {
    return process.env.STELLAR_RECEIVING_ACCOUNT || "";
  },
};

// --- Rate Limiters ---
// Read endpoints: higher limit (info lookups, status checks)
const sep31ReadLimiter = process.env.NODE_ENV === "test"
  ? (req: any, res: any, next: any) => next()
  : rateLimit({
      windowMs: 60 * 1000,
      max: 30,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many requests, please try again later." },
    });

// Write endpoints: strict limit (transaction creation)
const sep31WriteLimiter = process.env.NODE_ENV === "test"
  ? (req: any, res: any, next: any) => next()
  : rateLimit({
      windowMs: 60 * 1000,
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many requests, please try again later." },
    });

// --- Helpers ---
function getAssetCode(): string {
  const asset = getConfiguredPaymentAsset();
  return asset.isNative() ? "XLM" : asset.getCode();
}

function getAssetString(): string {
  const asset = getConfiguredPaymentAsset();
  return asset.isNative() ? "stellar:native" : `stellar:${asset.getCode()}:${asset.getIssuer()}`;
}

function parseAssetCode(rawCode: string): string {
  if (rawCode.startsWith("stellar:")) {
    const parts = rawCode.split(":");
    return parts[1];
  }
  return rawCode;
}

function calculateFee(amount: number): { fee: number; total: number } {
  let fee = SEP31_CONFIG.feeFixed + (amount * SEP31_CONFIG.feePercent / 100);
  fee = parseFloat(fee.toFixed(7));
  return { fee, total: parseFloat((amount + fee).toFixed(7)) };
}

function generateMemo(): string {
  // Generate a short unique memo (max 28 chars for Stellar text memo)
  return crypto.randomUUID().replace(/-/g, "").substring(0, 28);
}

// Validate UUID format
function isValidUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// --- SEP-31 Sender Registration Schema ---
const PutSenderSchema = z.object({
  // Required sender fields per SEP-31 spec
  first_name: z.string().min(1, "First name is required"),
  last_name: z.string().min(1, "Last name is required"),
  email_address: z.string().email("Invalid email address"),
  
  // Optional but commonly required fields
  mobile_number: z.string().optional(),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format (YYYY-MM-DD)").optional(),
  birth_place: z.string().optional(),
  birth_country: z.string().length(3).optional(),
  
  // Address fields
  address: z.string().optional(),
  address_country_code: z.string().length(3).optional(),
  state_or_province: z.string().optional(),
  city: z.string().optional(),
  postal_code: z.string().optional(),
  
  // ID document fields
  id_type: z.string().optional(),
  id_country_code: z.string().length(3).optional(),
  id_issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format (YYYY-MM-DD)").optional(),
  id_expiration_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format (YYYY-MM-DD)").optional(),
  id_number: z.string().optional(),
  
  // Additional fields
  tax_id: z.string().optional(),
  tax_id_name: z.string().optional(),
  occupation: z.string().optional(),
  employer_name: z.string().optional(),
  employer_address: z.string().optional(),
}).catchall(z.any()); // Allow additional custom fields

// --- Routes ---

/**
 * GET /info
 *
 * Returns supported assets, fees, required fields, and sender/receiver types
 * per the SEP-31 specification.
 */
router.get("/info", sep31ReadLimiter, async (req: Request, res: Response) => {
  try {
    const assetCode = getAssetCode();

    return res.json({
      receive: {
        [assetCode]: {
          enabled: true,
          fee_fixed: SEP31_CONFIG.feeFixed,
          fee_percent: SEP31_CONFIG.feePercent,
          min_amount: SEP31_CONFIG.minAmount,
          max_amount: SEP31_CONFIG.maxAmount,
          sender_sep12_type: "sep31-sender",
          receiver_sep12_type: "sep31-receiver",
          fields: {
            transaction: {
              receiver_id: {
                description: "The SEP-12 ID of the receiver",
                optional: false,
              },
              sender_id: {
                description: "The SEP-12 ID of the sender",
                optional: false,
              },
              receiver_routing_number: {
                description: "Routing number of the receiver's bank account",
                optional: true,
              },
              receiver_account_number: {
                description: "Account number of the receiver's bank or mobile money account",
                optional: true,
              },
              type: {
                description: "Type of payout: SWIFT, SEPA, or mobile_money",
                optional: true,
              },
            },
          },
        },
      },
    });
  } catch (error: any) {
    console.error("SEP-31 /info error:", error);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Internal server error");
  }
});

/**
 * POST /transactions
 *
 * Creates a new cross-border payment transaction.
 * Validates amount, asset, sender/receiver fields, and returns
 * the Stellar account + memo for the sender to make payment.
 */
router.post("/transactions", sep31WriteLimiter, async (req: Request, res: Response) => {
  const {
    amount,
    asset_code,
    asset_issuer,
    sender_id,
    receiver_id,
    fields,
    lang,
  } = req.body;

  // --- Input Validation ---
  if (!amount || !asset_code) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Missing required fields: amount, asset_code", {
      error: "invalid_request",
      message: "Missing required fields: amount, asset_code",
    });
  }

  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Amount must be a positive number", {
      error: "invalid_request",
      message: "Amount must be a positive number",
    });
  }

  if (parsedAmount < SEP31_CONFIG.minAmount) {
    throw createError(ERROR_CODES.INVALID_INPUT, `Amount below minimum: ${SEP31_CONFIG.minAmount}`, {
      error: "invalid_request",
      message: `Amount below minimum: ${SEP31_CONFIG.minAmount}`,
    });
  }

  if (parsedAmount > SEP31_CONFIG.maxAmount) {
    throw createError(ERROR_CODES.INVALID_INPUT, `Amount above maximum: ${SEP31_CONFIG.maxAmount}`, {
      error: "invalid_request",
      message: `Amount above maximum: ${SEP31_CONFIG.maxAmount}`,
    });
  }

  const cleanAssetCode = parseAssetCode(asset_code);
  const configuredCode = getAssetCode();

  if (cleanAssetCode !== configuredCode) {
    throw createError(ERROR_CODES.INVALID_INPUT, `Asset ${cleanAssetCode} is not supported. Supported: ${configuredCode}`, {
      error: "invalid_request",
      message: `Asset ${cleanAssetCode} is not supported. Supported: ${configuredCode}`,
    });
  }

  // Validate asset_issuer if provided (non-native assets)
  const configuredAsset = getConfiguredPaymentAsset();
  if (asset_issuer && !configuredAsset.isNative()) {
    if (asset_issuer !== configuredAsset.getIssuer()) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Asset issuer does not match configured issuer", {
        error: "invalid_request",
        message: "Asset issuer does not match configured issuer",
      });
    }
  }

  // Extract sender/receiver from top-level or nested fields
  const txFields = fields?.transaction || {};
  const finalSenderId = sender_id || txFields.sender_id;
  const finalReceiverId = receiver_id || txFields.receiver_id;

  if (!finalSenderId || !finalReceiverId) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Missing required fields: sender_id, receiver_id", {
      error: "invalid_request",
      message: "Missing required fields: sender_id, receiver_id",
    });
  }

  if (!SEP31_CONFIG.receivingAccount) {
    console.error("SEP-31: STELLAR_RECEIVING_ACCOUNT not configured");
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Anchor receiving account not configured", {
      error: "server_error",
      message: "Anchor receiving account not configured",
    });
  }

  try {
    const memo = generateMemo();
    const { fee, total } = calculateFee(parsedAmount);
    const amountOut = parsedAmount; // Amount delivered to receiver (before payout fees)

    // Build sender/receiver payload mapping
    const metadata = {
      sep31: {
        status: Sep31Status.PendingSender,
        sender_id: finalSenderId,
        receiver_id: finalReceiverId,
        receiver_routing_number: txFields.receiver_routing_number || null,
        receiver_account_number: txFields.receiver_account_number || null,
        payout_type: txFields.type || "mobile_money",
        message: txFields.message || null,
        memo,
        memo_type: "text",
        amount_in: total.toString(),
        amount_out: amountOut.toString(),
        amount_fee: fee.toString(),
        asset_code: cleanAssetCode,
        asset_issuer: configuredAsset.isNative() ? null : configuredAsset.getIssuer(),
        lang: lang || "en",
      },
    };

    const newTransaction = await transactionModel.create({
      type: "deposit",
      amount: total.toString(),
      phoneNumber: "SEP-31",
      provider: "stellar-sep31",
      stellarAddress: SEP31_CONFIG.receivingAccount,
      status: TransactionStatus.Pending,
      metadata,
      notes: `SEP-31 cross-border payment from ${finalSenderId} to ${finalReceiverId}`,
    });

    return res.status(201).json({
      id: newTransaction.id,
      status: Sep31Status.PendingSender,
      status_eta: SEP31_CONFIG.statusEta,
      stellar_account_id: SEP31_CONFIG.receivingAccount,
      stellar_memo_type: "text",
      stellar_memo: memo,
      amount_in: total.toString(),
      amount_in_asset: getAssetString(),
      amount_out: amountOut.toString(),
      amount_out_asset: getAssetString(),
      amount_fee: fee.toString(),
      amount_fee_asset: getAssetString(),
    });
  } catch (error: any) {
    console.error("SEP-31 POST /transactions error:", error);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Internal server error");
  }
});

/**
 * GET /transactions/:id
 *
 * Returns the current status and details of a SEP-31 transaction.
 */
router.get("/transactions/:id", sep31ReadLimiter, async (req: Request, res: Response) => {
  const { id } = req.params;

  if (!isValidUUID(id)) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid transaction ID format", {
      error: "Invalid transaction ID format",
    });
  }

  try {
    const transaction = await transactionModel.findById(id);

    if (!transaction) {
      throw createError(ERROR_CODES.NOT_FOUND, "Transaction not found", {
        error: "Transaction not found",
      });
    }

    // Verify this is a SEP-31 transaction
    const sep31Meta = (transaction.metadata as any)?.sep31;
    if (!sep31Meta) {
      throw createError(ERROR_CODES.NOT_FOUND, "Transaction not found", {
        error: "Transaction not found",
      });
    }

    const sep31Status = mapToSep31Status(transaction.status, transaction.metadata);
    const assetString = getAssetString();

    return res.json({
      transaction: {
        id: transaction.id,
        status: sep31Status,
        status_eta: sep31Status === Sep31Status.Completed || sep31Status === Sep31Status.Error
          ? null
          : SEP31_CONFIG.statusEta,
        amount_in: sep31Meta.amount_in || transaction.amount,
        amount_in_asset: assetString,
        amount_out: sep31Meta.amount_out || transaction.amount,
        amount_out_asset: assetString,
        amount_fee: sep31Meta.amount_fee || "0",
        amount_fee_asset: assetString,
        stellar_account_id: SEP31_CONFIG.receivingAccount,
        stellar_memo_type: sep31Meta.memo_type || "text",
        stellar_memo: sep31Meta.memo || "",
        stellar_transaction_id: sep31Meta.stellar_transaction_id || null,
        started_at: transaction.createdAt.toISOString(),
        completed_at: sep31Status === Sep31Status.Completed
          ? (transaction.updatedAt || transaction.createdAt).toISOString()
          : null,
        required_info_message: sep31Meta.required_info_message || null,
        required_info_updates: sep31Meta.required_info_updates || null,
        message: sep31Meta.message || null,
        refunded: sep31Meta.refunded || false,
      },
    });
  } catch (error: any) {
    console.error("SEP-31 GET /transactions/:id error:", error);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Internal server error");
  }
});

/**
 * PATCH /transactions/:id
 *
 * Updates transaction fields (e.g. when the anchor requests additional info).
 * Only allows updates when the transaction is in a pending state.
 */
router.patch("/transactions/:id", sep31WriteLimiter, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { fields } = req.body;

  if (!isValidUUID(id)) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid transaction ID format", {
      error: "Invalid transaction ID format",
    });
  }

  if (!fields || !fields.transaction) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Missing required: fields.transaction", {
      error: "invalid_request",
      message: "Missing required: fields.transaction",
    });
  }

  try {
    const transaction = await transactionModel.findById(id);

    if (!transaction) {
      throw createError(ERROR_CODES.NOT_FOUND, "Transaction not found", {
        error: "Transaction not found",
      });
    }

    const sep31Meta = (transaction.metadata as any)?.sep31;
    if (!sep31Meta) {
      throw createError(ERROR_CODES.NOT_FOUND, "Transaction not found", {
        error: "Transaction not found",
      });
    }

    const currentStatus = mapToSep31Status(transaction.status, transaction.metadata);

    // Only allow updates on pending transactions
    if (currentStatus === Sep31Status.Completed) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Cannot update a completed transaction", {
        error: "invalid_request",
        message: "Cannot update a completed transaction",
      });
    }

    // Merge updated fields into metadata
    const txFields = fields.transaction;
    const updatedSep31 = {
      ...sep31Meta,
      ...(txFields.receiver_routing_number !== undefined && { receiver_routing_number: txFields.receiver_routing_number }),
      ...(txFields.receiver_account_number !== undefined && { receiver_account_number: txFields.receiver_account_number }),
      ...(txFields.type !== undefined && { payout_type: txFields.type }),
      required_info_message: null,
      required_info_updates: null,
    };

    const updatedMetadata = {
      ...(transaction.metadata as Record<string, unknown>),
      sep31: updatedSep31,
    };

    await transactionModel.updateMetadata(id, updatedMetadata);

    return res.json({ status: "updated" });
  } catch (error: any) {
    console.error("SEP-31 PATCH /transactions/:id error:", error);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Internal server error");
  }
});

/**
 * PUT /customer/sender
 *
 * Registers or updates a sender for SEP-31 cross-border payments.
 * Validates required sender fields per SEP-31 spec and stores them
 * linked to the requesting API key's organization.
 */
router.put("/customer/sender", requireAuth, sep31WriteLimiter, async (req: Request, res: Response) => {
  try {
    // Validate request body
    const validatedData = PutSenderSchema.parse(req.body);
    
    // Extract API key from request (set by requireAuth middleware)
    const apiKey = req.header("X-API-Key");
    if (!apiKey) {
      throw createError(ERROR_CODES.UNAUTHORIZED, "API key required", {
        error: "unauthorized",
        message: "API key required for sender registration",
      });
    }
    
    // Get API key details to extract organization_id if available
    const apiKeyQuery = `
      SELECT permissions, is_active, expires_at
      FROM api_keys
      WHERE key = $1
      LIMIT 1
    `;
    const apiKeyResult = await pool.query(apiKeyQuery, [apiKey]);
    
    if (apiKeyResult.rows.length === 0) {
      throw createError(ERROR_CODES.UNAUTHORIZED, "Invalid API key", {
        error: "unauthorized",
        message: "Invalid API key",
      });
    }
    
    const apiKeyRow = apiKeyResult.rows[0];
    if (!apiKeyRow.is_active) {
      throw createError(ERROR_CODES.UNAUTHORIZED, "API key is inactive", {
        error: "unauthorized",
        message: "API key is inactive",
      });
    }
    if (apiKeyRow.expires_at && new Date(apiKeyRow.expires_at) < new Date()) {
      throw createError(ERROR_CODES.UNAUTHORIZED, "API key has expired", {
        error: "unauthorized",
        message: "API key has expired",
      });
    }
    
    // Check if sender already exists for this API key + id_number combination (idempotent)
    const existingSenderQuery = `
      SELECT id FROM sep31_senders
      WHERE api_key_id = $1 AND id_number = $2
      LIMIT 1
    `;
    
    let senderId: string;
    
    if (validatedData.id_number) {
      const existingResult = await pool.query(existingSenderQuery, [apiKey, validatedData.id_number]);
      
      if (existingResult.rows.length > 0) {
        // Update existing sender
        senderId = existingResult.rows[0].id;
        
        const updateQuery = `
          UPDATE sep31_senders
          SET
            first_name = $1,
            last_name = $2,
            email_address = $3,
            mobile_number = $4,
            birth_date = $5,
            birth_place = $6,
            birth_country = $7,
            address = $8,
            address_country_code = $9,
            state_or_province = $10,
            city = $11,
            postal_code = $12,
            id_type = $13,
            id_country_code = $14,
            id_issue_date = $15,
            id_expiration_date = $16,
            tax_id = $17,
            tax_id_name = $18,
            occupation = $19,
            employer_name = $20,
            employer_address = $21,
            status = 'ACCEPTED'
          WHERE id = $22
        `;
        
        await pool.query(updateQuery, [
          validatedData.first_name,
          validatedData.last_name,
          validatedData.email_address,
          validatedData.mobile_number || null,
          validatedData.birth_date || null,
          validatedData.birth_place || null,
          validatedData.birth_country || null,
          validatedData.address || null,
          validatedData.address_country_code || null,
          validatedData.state_or_province || null,
          validatedData.city || null,
          validatedData.postal_code || null,
          validatedData.id_type || null,
          validatedData.id_country_code || null,
          validatedData.id_issue_date || null,
          validatedData.id_expiration_date || null,
          validatedData.tax_id || null,
          validatedData.tax_id_name || null,
          validatedData.occupation || null,
          validatedData.employer_name || null,
          validatedData.employer_address || null,
          senderId,
        ]);
        
        return res.json({
          id: senderId,
          status: "ACCEPTED",
          message: "Sender information updated successfully",
        });
      }
    }
    
    // Create new sender
    const insertQuery = `
      INSERT INTO sep31_senders (
        api_key_id,
        first_name,
        last_name,
        email_address,
        mobile_number,
        birth_date,
        birth_place,
        birth_country,
        address,
        address_country_code,
        state_or_province,
        city,
        postal_code,
        id_type,
        id_country_code,
        id_issue_date,
        id_expiration_date,
        id_number,
        tax_id,
        tax_id_name,
        occupation,
        employer_name,
        employer_address,
        sep12_type,
        status
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25
      )
      RETURNING id
    `;
    
    const insertResult = await pool.query(insertQuery, [
      apiKey,
      validatedData.first_name,
      validatedData.last_name,
      validatedData.email_address,
      validatedData.mobile_number || null,
      validatedData.birth_date || null,
      validatedData.birth_place || null,
      validatedData.birth_country || null,
      validatedData.address || null,
      validatedData.address_country_code || null,
      validatedData.state_or_province || null,
      validatedData.city || null,
      validatedData.postal_code || null,
      validatedData.id_type || null,
      validatedData.id_country_code || null,
      validatedData.id_issue_date || null,
      validatedData.id_expiration_date || null,
      validatedData.id_number || null,
      validatedData.tax_id || null,
      validatedData.tax_id_name || null,
      validatedData.occupation || null,
      validatedData.employer_name || null,
      validatedData.employer_address || null,
      "sep31-sender",
      "ACCEPTED",
    ]);
    
    senderId = insertResult.rows[0].id;
    
    return res.status(201).json({
      id: senderId,
      status: "ACCEPTED",
      message: "Sender registered successfully",
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Validation failed", {
        error: "invalid_request",
        message: error.errors[0]?.message || "Validation failed",
        details: error.errors,
      });
    }
    
    console.error("SEP-31 PUT /customer/sender error:", error);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Internal server error", {
      error: "server_error",
      message: "Failed to register sender",
    });
  }
});

/**
 * GET /customer/sender/:id
 *
 * Retrieves sender information by ID.
 */
router.get("/customer/sender/:id", requireAuth, sep31ReadLimiter, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    if (!isValidUUID(id)) {
      throw createError(ERROR_CODES.INVALID_INPUT, "Invalid sender ID format", {
        error: "invalid_request",
        message: "Invalid sender ID format",
      });
    }
    
    const apiKey = req.header("X-API-Key");
    if (!apiKey) {
      throw createError(ERROR_CODES.UNAUTHORIZED, "API key required", {
        error: "unauthorized",
        message: "API key required",
      });
    }
    
    const query = `
      SELECT 
        id, first_name, last_name, email_address, mobile_number,
        birth_date, birth_place, birth_country,
        address, address_country_code, state_or_province, city, postal_code,
        id_type, id_country_code, id_issue_date, id_expiration_date, id_number,
        tax_id, tax_id_name, occupation, employer_name, employer_address,
        sep12_type, status, created_at, updated_at
      FROM sep31_senders
      WHERE id = $1 AND api_key_id = $2
      LIMIT 1
    `;
    
    const result = await pool.query(query, [id, apiKey]);
    
    if (result.rows.length === 0) {
      throw createError(ERROR_CODES.NOT_FOUND, "Sender not found", {
        error: "not_found",
        message: "Sender not found",
      });
    }
    
    const sender = result.rows[0];
    
    return res.json({
      id: sender.id,
      first_name: sender.first_name,
      last_name: sender.last_name,
      email_address: sender.email_address,
      mobile_number: sender.mobile_number,
      birth_date: sender.birth_date,
      birth_place: sender.birth_place,
      birth_country: sender.birth_country,
      address: sender.address,
      address_country_code: sender.address_country_code,
      state_or_province: sender.state_or_province,
      city: sender.city,
      postal_code: sender.postal_code,
      id_type: sender.id_type,
      id_country_code: sender.id_country_code,
      id_issue_date: sender.id_issue_date,
      id_expiration_date: sender.id_expiration_date,
      id_number: sender.id_number,
      tax_id: sender.tax_id,
      tax_id_name: sender.tax_id_name,
      occupation: sender.occupation,
      employer_name: sender.employer_name,
      employer_address: sender.employer_address,
      sep12_type: sender.sep12_type,
      status: sender.status,
      created_at: sender.created_at,
      updated_at: sender.updated_at,
    });
  } catch (error: any) {
    console.error("SEP-31 GET /customer/sender/:id error:", error);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Internal server error", {
      error: "server_error",
      message: "Failed to retrieve sender",
    });
  }
});

export { SEP31_CONFIG, calculateFee, mapToSep31Status, isValidTransition, VALID_TRANSITIONS };
export default router;
