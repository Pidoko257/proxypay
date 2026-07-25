# Task #157 - Input Validation Implementation Guide

## File Structure

```
src/middleware/validators/
├── index.ts              # Main exports
├── schemas.ts            # Zod schemas for all endpoints
├── custom.ts             # Custom validators
├── errorFormatter.ts     # Error response formatting
└── __tests__/
    ├── schemas.test.ts
    ├── custom.test.ts
    └── integration.test.ts
```

## 1. Custom Validators (custom.ts)

```typescript
import { z } from "zod";
import {
  parsePhoneNumberFromString,
  isValidPhoneNumber,
} from "libphonenumber-js";

/**
 * Phone number validator
 * Supports international format with country code
 */
export const phoneValidator = z
  .string()
  .min(6, "Phone number too short")
  .max(15, "Phone number too long")
  .refine(
    (val) => {
      // Allow common formats: +1234567890, 1234567890, (123) 456-7890
      const normalized = val.replace(/\D/g, "");
      return normalized.length >= 6 && normalized.length <= 15;
    },
    { message: "Invalid phone number format" },
  )
  .refine(
    (val) => {
      try {
        const parsed = parsePhoneNumberFromString(val, "US");
        return parsed && isValidPhoneNumber(val);
      } catch {
        return false;
      }
    },
    { message: "Phone number invalid for country" },
  );

/**
 * Stellar wallet address validator
 * G... or M... format, 56 characters
 */
export const stellarAddressValidator = z
  .string()
  .regex(/^G[A-Z2-7]{55}$|^M[A-Z2-7]{55}$/, "Invalid Stellar address");

/**
 * Stellar account ID validator
 * Alternative for G-addresses
 */
export const stellarAccountValidator = z
  .string()
  .regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar account ID");

/**
 * Muxed account validator (for fund distribution)
 * Format: G....:account_id
 */
export const muxedAccountValidator = z.string().refine(
  (val) => {
    const parts = val.split(":");
    if (parts.length !== 2) return false;
    const [account, id] = parts;
    return /^G[A-Z2-7]{55}$/.test(account) && /^\d+$/.test(id);
  },
  { message: "Invalid muxed account format (expected: ACCOUNT:ID)" },
);

/**
 * Currency amount validator
 * Positive decimal with max 18 decimal places (Stellar limit)
 */
export const amountValidator = z
  .string()
  .or(z.number())
  .transform((val) => String(val))
  .refine(
    (val) => /^\d+(\.\d{1,18})?$/.test(val),
    "Amount must be positive decimal with max 18 decimals",
  )
  .refine((val) => parseFloat(val) > 0, "Amount must be greater than 0")
  .refine((val) => parseFloat(val) <= 1e15, "Amount exceeds maximum limit");

/**
 * XAF currency amount validator
 * Local currency with 0-2 decimal places
 */
export const xafAmountValidator = z
  .string()
  .or(z.number())
  .transform((val) => String(val))
  .refine(
    (val) => /^\d+(\.\d{1,2})?$/.test(val),
    "XAF amount must have 0-2 decimal places",
  )
  .refine((val) => parseFloat(val) > 0, "Amount must be greater than 0")
  .refine((val) => parseFloat(val) <= 1e10, "XAF amount exceeds maximum limit");

/**
 * Email validator
 */
export const emailValidator = z
  .string()
  .email("Invalid email format")
  .toLowerCase()
  .max(255, "Email too long");

/**
 * Password validator
 * Min 12 chars, 1 upper, 1 lower, 1 number, 1 special
 */
export const passwordValidator = z
  .string()
  .min(12, "Password must be at least 12 characters")
  .max(255, "Password too long")
  .refine((val) => /[A-Z]/.test(val), "Password must contain uppercase letter")
  .refine((val) => /[a-z]/.test(val), "Password must contain lowercase letter")
  .refine((val) => /\d/.test(val), "Password must contain number")
  .refine(
    (val) => /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(val),
    "Password must contain special character",
  );

/**
 * UUID validator
 */
export const uuidValidator = z.string().uuid("Invalid UUID format");

/**
 * ISO date string validator
 */
export const dateValidator = z
  .string()
  .datetime("Invalid date format, use ISO 8601")
  .or(z.date());

/**
 * Enum validator for providers
 */
export const providerValidator = z.enum(["mtn", "airtel", "orange"], {
  errorMap: () => ({ message: "Provider must be: mtn, airtel, or orange" }),
});

/**
 * Transaction status validator
 */
export const transactionStatusValidator = z.enum(
  ["pending", "completed", "failed", "cancelled", "disputed"],
  {
    errorMap: () => ({ message: "Invalid transaction status" }),
  },
);

/**
 * KYC tier validator
 */
export const kycTierValidator = z.enum(["unverified", "basic", "full"], {
  errorMap: () => ({ message: "Invalid KYC tier" }),
});

/**
 * API key format validator
 * Format: pp_[live|test]_[alphanumeric]{32}
 */
export const apiKeyValidator = z
  .string()
  .regex(/^pp_(live|test)_[a-zA-Z0-9]{32}$/, "Invalid API key format");

/**
 * Country code validator (ISO 3166-1 alpha-2)
 */
export const countryCodeValidator = z
  .string()
  .length(2, "Country code must be 2 characters")
  .uppercase()
  .refine(
    (val) => /^[A-Z]{2}$/.test(val),
    "Country code must be uppercase letters",
  );

/**
 * Cross-field validation: Amount between min and max
 */
export const amountRangeValidator = (min: number, max: number) =>
  z
    .string()
    .transform((val) => parseFloat(val))
    .refine((val) => val >= min && val <= max, {
      message: `Amount must be between ${min} and ${max}`,
    });

/**
 * Composite validator: Phone + Provider combination
 */
export const phoneProviderValidator = z
  .object({
    phone: phoneValidator,
    provider: providerValidator,
  })
  .refine(
    ({ phone, provider }) => {
      // Provider-specific phone validation rules
      if (provider === "mtn" && !phone.match(/^(\+?237|\+237)/)) {
        return false;
      }
      if (provider === "airtel" && !phone.match(/^(\+?255|\+255)/)) {
        return false;
      }
      return true;
    },
    {
      message: "Phone number not valid for selected provider",
      path: ["phone"],
    },
  );

/**
 * ID number validator (flexible format)
 * Supports multiple ID types
 */
export const idNumberValidator = z
  .string()
  .min(5, "ID number too short")
  .max(20, "ID number too long")
  .refine(
    (val) => /^[a-zA-Z0-9-/]+$/.test(val),
    "ID number contains invalid characters",
  );

/**
 * Bank account validator
 * IBAN format or local account number
 */
export const bankAccountValidator = z
  .string()
  .min(8, "Bank account too short")
  .max(34, "Bank account too long")
  .refine((val) => {
    // IBAN format
    if (val.startsWith("CM") || val.startsWith("KE")) {
      return /^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(val);
    }
    // Local format
    return /^[a-zA-Z0-9-/]+$/.test(val);
  }, "Invalid bank account format");

/**
 * Transaction limit validator
 * Enforces business rules for amounts
 */
export const transactionLimitValidator = (userKycTier: string) => {
  const limits: Record<string, { min: number; max: number }> = {
    unverified: { min: 100, max: 10000 },
    basic: { min: 100, max: 100000 },
    full: { min: 100, max: 1000000 },
  };

  const limit = limits[userKycTier] || limits.unverified;
  return amountRangeValidator(limit.min, limit.max);
};
```

## 2. Request Schemas (schemas.ts)

```typescript
import { z } from "zod";
import {
  phoneValidator,
  stellarAddressValidator,
  amountValidator,
  xafAmountValidator,
  emailValidator,
  passwordValidator,
  uuidValidator,
  providerValidator,
  transactionStatusValidator,
  kycTierValidator,
  apiKeyValidator,
  countryCodeValidator,
  phoneProviderValidator,
  idNumberValidator,
} from "./custom";

// ============================================================================
// AUTH SCHEMAS
// ============================================================================

export const registerSchema = z.object({
  email: emailValidator,
  password: passwordValidator,
  phoneNumber: phoneValidator,
  firstName: z.string().min(2).max(50),
  lastName: z.string().min(2).max(50),
  country: countryCodeValidator.optional(),
  acceptTerms: z.boolean().refine((val) => val === true, {
    message: "Must accept terms and conditions",
  }),
});

export const loginSchema = z.object({
  email: emailValidator,
  password: z.string().min(1, "Password required"),
});

export const enable2FASchema = z.object({
  method: z.enum(["totp", "sms", "email"]),
});

export const verify2FASchema = z.object({
  code: z.string().length(6, "Code must be 6 digits").regex(/^\d+$/),
  backup: z.boolean().optional(),
});

// ============================================================================
// TRANSACTION SCHEMAS
// ============================================================================

export const depositSchema = z.object({
  amount: xafAmountValidator,
  provider: providerValidator,
  phoneNumber: phoneValidator,
  memo: z.string().max(280).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

export const withdrawSchema = z.object({
  amount: amountValidator, // Stellar amount (XLM or USDC)
  provider: providerValidator,
  phoneNumber: phoneValidator,
  asset: z.enum(["xlm", "usdc"]).default("xlm"),
  twoFactorCode: z.string().length(6).regex(/^\d+$/),
  metadata: z.record(z.string(), z.any()).optional(),
});

export const transactionQuerySchema = z.object({
  status: transactionStatusValidator.optional(),
  provider: providerValidator.optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
  sort: z.enum(["asc", "desc"]).default("desc"),
});

export const cancelTransactionSchema = z.object({
  reason: z.string().max(500).optional(),
  twoFactorCode: z.string().length(6).regex(/^\d+/),
});

// ============================================================================
// KYC SCHEMAS
// ============================================================================

export const submitKYCSchema = z.object({
  tier: kycTierValidator,
  documents: z
    .array(
      z.object({
        type: z.enum(["id", "selfie", "proof_of_address", "video"]),
        fileUrl: z.string().url(),
        expiryDate: z.string().datetime().optional(),
      }),
    )
    .min(1),
  address: z.object({
    street: z.string().min(5).max(100),
    city: z.string().min(2).max(50),
    state: z.string().max(50).optional(),
    postalCode: z.string().max(20),
    country: countryCodeValidator,
  }),
});

// ============================================================================
// VAULT SCHEMAS
// ============================================================================

export const createVaultSchema = z.object({
  name: z.string().min(3).max(100),
  asset: z.enum(["xlm", "usdc"]),
  description: z.string().max(500).optional(),
  tags: z.array(z.string()).max(10).optional(),
});

export const transferVaultSchema = z
  .object({
    amount: amountValidator,
    toAddress: stellarAddressValidator.optional(),
    toVaultId: uuidValidator.optional(),
    asset: z.enum(["xlm", "usdc"]),
    memo: z.string().max(280).optional(),
    twoFactorCode: z.string().length(6).regex(/^\d+$/),
  })
  .refine((data) => data.toAddress || data.toVaultId, {
    message: "Either toAddress or toVaultId must be provided",
  });

// ============================================================================
// DISPUTE SCHEMAS
// ============================================================================

export const createDisputeSchema = z.object({
  transactionId: uuidValidator,
  reason: z.enum(["unauthorized", "not_received", "incorrect_amount", "other"]),
  description: z.string().min(10).max(1000),
  evidence: z
    .array(
      z.object({
        type: z.enum(["screenshot", "receipt", "email", "other"]),
        fileUrl: z.string().url(),
      }),
    )
    .optional(),
});

// ============================================================================
// ADMIN SCHEMAS
// ============================================================================

export const createAPIKeySchema = z.object({
  name: z.string().min(3).max(100),
  description: z.string().max(500).optional(),
  scopes: z.array(z.string()).min(1).max(20),
  expiresIn: z.enum(["7d", "30d", "90d", "1y", "never"]).default("90d"),
  ipWhitelist: z.array(z.string().ip()).max(10).optional(),
});

export const updateUserSchema = z.object({
  email: emailValidator.optional(),
  phoneNumber: phoneValidator.optional(),
  kycTier: kycTierValidator.optional(),
  status: z.enum(["active", "suspended", "inactive"]).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

export const bulkTransactionSchema = z.object({
  operations: z
    .array(
      z.object({
        type: z.enum(["deposit", "withdraw"]),
        phoneNumber: phoneValidator,
        provider: providerValidator,
        amount: xafAmountValidator,
        metadata: z.record(z.string(), z.any()).optional(),
      }),
    )
    .min(1)
    .max(1000),
  dryRun: z.boolean().default(false),
});
```

## 3. Error Formatter (errorFormatter.ts)

```typescript
import { ZodError } from "zod";
import { Request, Response } from "express";

export interface ValidationError {
  field: string;
  message: string;
  code?: string;
}

export interface ValidationErrorResponse {
  success: false;
  error: "VALIDATION_ERROR";
  message: string;
  details: ValidationError[];
  timestamp: string;
  requestId?: string;
}

/**
 * Format Zod validation errors into consistent response
 */
export function formatZodErrors(error: ZodError): ValidationError[] {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "root",
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Format errors for API response
 */
export function formatValidationResponse(
  req: Request,
  errors: ValidationError[],
): ValidationErrorResponse {
  return {
    success: false,
    error: "VALIDATION_ERROR",
    message: `Validation failed: ${errors.length} error(s)`,
    details: errors,
    timestamp: new Date().toISOString(),
    requestId: (req as any).id,
  };
}

/**
 * Log validation failure for audit trail
 */
export function logValidationFailure(
  req: Request,
  errors: ValidationError[],
  context: string,
): void {
  const logger = require("../utils/logger").logger;
  logger.warn("Validation failed", {
    endpoint: req.path,
    method: req.method,
    errorCount: errors.length,
    errors: errors.map((e) => `${e.field}: ${e.message}`),
    ip: req.ip,
    userId: (req as any).user?.id,
    context,
    requestId: (req as any).id,
  });
}
```

## 4. Middleware Helpers (index.ts)

```typescript
import { Request, Response, NextFunction } from "express";
import { ZodSchema, ZodError } from "zod";
import {
  formatZodErrors,
  formatValidationResponse,
  logValidationFailure,
} from "./errorFormatter";

/**
 * Generic validation middleware factory
 */
function createValidator(
  schema: ZodSchema,
  source: "body" | "query" | "params",
) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const data =
        source === "body"
          ? req.body
          : source === "query"
            ? req.query
            : req.params;
      schema.parse(data);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errors = formatZodErrors(error);
        logValidationFailure(req, errors, `${source}_validation`);
        return res.status(400).json(formatValidationResponse(req, errors));
      }
      next(error);
    }
  };
}

export function validateBody(schema: ZodSchema) {
  return createValidator(schema, "body");
}

export function validateQuery(schema: ZodSchema) {
  return createValidator(schema, "query");
}

export function validateParams(schema: ZodSchema) {
  return createValidator(schema, "params");
}

/**
 * Multi-source validation
 */
export function validateRequest(schemas: {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}) {
  return (req: Request, res: Response, next: NextFunction) => {
    const errors = [];

    if (schemas.body) {
      try {
        schemas.body.parse(req.body);
      } catch (error) {
        if (error instanceof ZodError) {
          errors.push(...formatZodErrors(error));
        }
      }
    }

    if (schemas.query) {
      try {
        schemas.query.parse(req.query);
      } catch (error) {
        if (error instanceof ZodError) {
          errors.push(...formatZodErrors(error));
        }
      }
    }

    if (schemas.params) {
      try {
        schemas.params.parse(req.params);
      } catch (error) {
        if (error instanceof ZodError) {
          errors.push(...formatZodErrors(error));
        }
      }
    }

    if (errors.length > 0) {
      logValidationFailure(req, errors, "multi_source_validation");
      return res.status(400).json(formatValidationResponse(req, errors));
    }

    next();
  };
}

export * from "./schemas";
export * from "./custom";
export * from "./errorFormatter";
```

## 5. Route Integration Example

```typescript
// src/routes/transactions.ts
import express from "express";
import {
  validateBody,
  validateQuery,
  depositSchema,
  withdrawSchema,
  transactionQuerySchema,
} from "../middleware/validators";
import { requireAuth } from "../middleware/auth";
import { transactionController } from "../controllers";

export const transactionRoutes = express.Router();

/**
 * Deposit: POST /api/transactions/deposit
 * Validates body according to depositSchema
 */
transactionRoutes.post(
  "/deposit",
  requireAuth,
  validateBody(depositSchema),
  transactionController.deposit,
);

/**
 * Withdraw: POST /api/transactions/withdraw
 * Validates body according to withdrawSchema
 */
transactionRoutes.post(
  "/withdraw",
  requireAuth,
  validateBody(withdrawSchema),
  transactionController.withdraw,
);

/**
 * List transactions: GET /api/transactions
 * Validates query parameters
 */
transactionRoutes.get(
  "/",
  requireAuth,
  validateQuery(transactionQuerySchema),
  transactionController.list,
);
```

## Testing Template

```typescript
// src/middleware/validators/__tests__/custom.test.ts
import {
  phoneValidator,
  stellarAddressValidator,
  amountValidator,
} from "../custom";

describe("Custom Validators", () => {
  describe("phoneValidator", () => {
    it("should accept valid international phone", () => {
      expect(phoneValidator.safeParse("+237123456789").success).toBe(true);
    });

    it("should reject invalid format", () => {
      expect(phoneValidator.safeParse("abc").success).toBe(false);
    });

    it("should normalize phone numbers", () => {
      const result = phoneValidator.safeParse("(237) 123-4567");
      expect(result.success).toBe(true);
    });
  });

  describe("stellarAddressValidator", () => {
    it("should accept valid Stellar address", () => {
      const address =
        "GBUDQWQ6CUYTVOHUWKD2NXQ4EQWFQ6U5UYIVL6DNSZ6YXCJJG3K4GLZM";
      expect(stellarAddressValidator.safeParse(address).success).toBe(true);
    });

    it("should reject invalid address", () => {
      expect(stellarAddressValidator.safeParse("INVALID").success).toBe(false);
    });
  });

  describe("amountValidator", () => {
    it("should accept valid amount", () => {
      expect(amountValidator.safeParse("100.50").success).toBe(true);
      expect(amountValidator.safeParse(100).success).toBe(true);
    });

    it("should reject zero or negative", () => {
      expect(amountValidator.safeParse("0").success).toBe(false);
      expect(amountValidator.safeParse("-10").success).toBe(false);
    });

    it("should enforce decimal places limit", () => {
      const tooMany = "100." + "1".repeat(19);
      expect(amountValidator.safeParse(tooMany).success).toBe(false);
    });
  });
});
```
