import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { resolveToBaseAddress } from "../stellar/muxed";
import { validateCountries, UnsupportedCountryError } from "../services/countryService";
import { ERROR_CODES } from "../constants/errorCodes";

function validateStellarAddress(address: string): boolean {
  if (!address || typeof address !== "string") return false;
  try {
    resolveToBaseAddress(address);
    return true;
  } catch {
    return false;
  }
}

/** ISO 3166-1 alpha-2: exactly two uppercase letters */
const countryCode = z
  .string()
  .regex(/^[A-Z]{2}$/, { message: "Country code must be ISO 3166-1 alpha-2 (e.g. CM, KE)" });

const transactionSchema = z.object({
  amount: z.number().positive({ message: "Amount must be a positive number" }),
  phoneNumber: z
    .string()
    .regex(/^\+?\d{10,15}$/, { message: "Invalid phone number format" }),
  provider: z.enum(["MTN", "AIRTEL", "ORANGE"], {
    message: "Provider must be one of: MTN, AIRTEL, ORANGE",
  }),
  stellarAddress: z
    .string()
    .refine(validateStellarAddress, { message: "Invalid Stellar address format (must be valid G-address or M-address)" }),
  userId: z.string().nonempty({ message: "userId is required" }),
  senderCountry: countryCode,
  recipientCountry: countryCode,
});

export const validateTransaction = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // 1. Schema validation
  const parsed = transactionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.issues,
    });
  }

  // 2. Country allowlist check
  const { senderCountry, recipientCountry } = parsed.data;
  try {
    await validateCountries(senderCountry, recipientCountry);
  } catch (err) {
    if (err instanceof UnsupportedCountryError) {
      return res.status(400).json({
        error: err.message,
        code: ERROR_CODES.ERR_UNSUPPORTED_COUNTRY,
        country: err.countryCode,
      });
    }
    return res.status(500).json({ error: "An internal server error occurred during validation" });
  }

  next();
};
