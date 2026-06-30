import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import * as jwt from "jsonwebtoken";
import { redisClient } from "../config/redis";
import { getConfiguredPaymentAsset } from "../services/stellar/assetService";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

const router = Router();

const QUOTE_EXPIRY_SECONDS = 60;

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not defined in environment variables");
  }
  return secret;
}

function getAssetString(): string {
  const asset = getConfiguredPaymentAsset();
  return asset.isNative() ? "stellar:native" : `stellar:${asset.getCode()}:${asset.getIssuer()}`;
}

interface QuoteTokenPayload {
  quoteId: string;
  sellAsset: string;
  buyAsset: string;
  sellAmount: string;
  buyAmount: string;
  price: string;
  expiresAt: number;
}

interface QuoteData {
  id: string;
  sellAsset: string;
  buyAsset: string;
  sellAmount: string;
  buyAmount: string;
  price: string;
  expiresAt: number;
  createdAt: number;
}

function generateQuoteId(): string {
  return crypto.randomUUID();
}

function isValidAssetCode(code: string): boolean {
  return /^[A-Z0-9]{1,12}$/.test(code) || code === "XLM" || code.startsWith("stellar:");
}

function parseAssetString(asset: string): { code: string; issuer?: string } {
  if (asset === "stellar:native" || asset === "XLM") {
    return { code: "XLM" };
  }
  const parts = asset.split(":");
  if (parts.length >= 3) {
    return { code: parts[1], issuer: parts[2] };
  }
  return { code: asset };
}

function validateStellarAccount(account: string): boolean {
  return /^G[A-Z0-9]{55}$/.test(account);
}

function generateIndicativeRate(): number {
  return 1.0;
}

function calculateBuyAmount(sellAmount: number, rate: number): number {
  return parseFloat((sellAmount * rate).toFixed(7));
}

async function storeQuote(quoteData: QuoteData): Promise<void> {
  const key = `sep38:quote:${quoteData.id}`;
  const ttl = Math.max(1, quoteData.expiresAt - Math.floor(Date.now() / 1000));
  await redisClient.setEx(key, ttl, JSON.stringify(quoteData));
}

async function getQuote(quoteId: string): Promise<QuoteData | null> {
  const key = `sep38:quote:${quoteId}`;
  const data = await redisClient.get(key);
  if (!data) return null;
  
  try {
    const parsed = JSON.parse(data) as QuoteData;
    const now = Math.floor(Date.now() / 1000);
    if (parsed.expiresAt < now) {
      await redisClient.del(key);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function deleteQuote(quoteId: string): Promise<void> {
  const key = `sep38:quote:${quoteId}`;
  await redisClient.del(key);
}

const sep38ReadLimiter = process.env.NODE_ENV === "test"
  ? (_req: any, _res: any, next: any) => next()
  : rateLimit({
      windowMs: 60 * 1000,
      max: 30,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many requests, please try again later." },
    });

const sep38WriteLimiter = process.env.NODE_ENV === "test"
  ? (_req: any, _res: any, next: any) => next()
  : rateLimit({
      windowMs: 60 * 1000,
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many requests, please try again later." },
    });

router.get("/prices", sep38ReadLimiter, async (req: Request, res: Response) => {
  try {
    const sellAsset = getAssetString();
    const indicativeRate = generateIndicativeRate();
    
    return res.json({
      stellar: sellAsset,
      rates: {
        [sellAsset]: {
          indicative: true,
          rate: indicativeRate.toString(),
          suffix: "/stellar",
        },
      },
    });
  } catch (error) {
    console.error("SEP-38 /prices error:", error);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Internal server error");
  }
});

router.get("/price", sep38ReadLimiter, async (req: Request, res: Response) => {
  const { sell_asset, buy_asset, sell_amount, buy_amount } = req.query;
  
  if (!sell_asset && !buy_asset) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Missing required query parameters: sell_asset or buy_asset", {
      error: "invalid_request",
      message: "Missing required query parameters: sell_asset or buy_asset",
    });
  }
  
  const indicativeRate = generateIndicativeRate();
  
  try {
    if (sell_amount) {
      const sellAmount = parseFloat(sell_amount as string);
      if (isNaN(sellAmount) || sellAmount <= 0) {
        throw createError(ERROR_CODES.INVALID_AMOUNT, "Invalid sell_amount", {
          error: "invalid_amount",
          message: "sell_amount must be a positive number",
        });
      }
      
      const buyAmount = calculateBuyAmount(sellAmount, indicativeRate);
      
      return res.json({
        buy_asset: buy_asset || sell_asset,
        sell_asset: sell_asset,
        buy_amount: buyAmount.toString(),
        sell_amount: sell_amount,
        price: indicativeRate.toString(),
        indicative: true,
      });
    }
    
    if (buy_amount) {
      const buyAmount = parseFloat(buy_amount as string);
      if (isNaN(buyAmount) || buyAmount <= 0) {
        throw createError(ERROR_CODES.INVALID_AMOUNT, "Invalid buy_amount", {
          error: "invalid_amount",
          message: "buy_amount must be a positive number",
        });
      }
      
      const buyAssetAmount = buyAmount;
      const sellAmount = buyAssetAmount;
      
      return res.json({
        buy_asset: buy_asset,
        sell_asset: sell_asset || buy_asset,
        buy_amount: buy_amount,
        sell_amount: sellAmount.toString(),
        price: indicativeRate.toString(),
        indicative: true,
      });
    }
    
    return res.json({
      buy_asset: buy_asset,
      sell_asset: sell_asset,
      price: indicativeRate.toString(),
      indicative: true,
    });
  } catch (error: any) {
    if (error.code) throw error;
    console.error("SEP-38 /price error:", error);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Internal server error");
  }
});

router.post("/quote", sep38WriteLimiter, async (req: Request, res: Response) => {
  const {
    sell_asset,
    buy_asset,
    sell_amount,
    buy_amount,
  } = req.body;
  
  if (!sell_asset && !buy_asset) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Missing required: sell_asset or buy_asset", {
      error: "invalid_request",
      message: "Missing required: sell_asset or buy_asset",
    });
  }
  
  const sellAsset = (sell_asset || buy_asset || getAssetString()) as string;
  const buyAsset = (buy_asset || sell_asset || getAssetString()) as string;
  
  if (!isValidAssetCode(sellAsset) && !sellAsset.startsWith("stellar:")) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid sell_asset format", {
      error: "invalid_request",
      message: "Invalid sell_asset format",
    });
  }
  
  if (!isValidAssetCode(buyAsset) && !buyAsset.startsWith("stellar:")) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Invalid buy_asset format", {
      error: "invalid_request",
      message: "Invalid buy_asset format",
    });
  }
  
  if (!sell_amount && !buy_amount) {
    throw createError(ERROR_CODES.INVALID_INPUT, "Missing required: sell_amount or buy_amount", {
      error: "invalid_request",
      message: "Missing required: sell_amount or buy_amount",
    });
  }
  
  let sellAmountStr: string;
  let buyAmountStr: string;
  let price: string;
  
  const indicativeRate = generateIndicativeRate();
  price = indicativeRate.toString();
  
  if (sell_amount && buy_amount) {
    const sellAmount = parseFloat(sell_amount);
    const buyAmount = parseFloat(buy_amount);
    
    if (isNaN(sellAmount) || sellAmount <= 0) {
      throw createError(ERROR_CODES.INVALID_AMOUNT, "Invalid sell_amount", {
        error: "invalid_amount",
        message: "sell_amount must be a positive number",
      });
    }
    
    if (isNaN(buyAmount) || buyAmount <= 0) {
      throw createError(ERROR_CODES.INVALID_AMOUNT, "Invalid buy_amount", {
        error: "invalid_amount",
        message: "buy_amount must be a positive number",
      });
    }
    
    sellAmountStr = sell_amount as string;
    buyAmountStr = buy_amount as string;
    price = (buyAmount / sellAmount).toFixed(7);
  } else if (sell_amount) {
    const sellAmount = parseFloat(sell_amount as string);
    if (isNaN(sellAmount) || sellAmount <= 0) {
      throw createError(ERROR_CODES.INVALID_AMOUNT, "Invalid sell_amount", {
        error: "invalid_amount",
        message: "sell_amount must be a positive number",
      });
    }
    
    const buyAmount = calculateBuyAmount(sellAmount, indicativeRate);
    sellAmountStr = sell_amount as string;
    buyAmountStr = buyAmount.toString();
    price = indicativeRate.toString();
  } else {
    const buyAmount = parseFloat(buy_amount as string);
    if (isNaN(buyAmount) || buyAmount <= 0) {
      throw createError(ERROR_CODES.INVALID_AMOUNT, "Invalid buy_amount", {
        error: "invalid_amount",
        message: "buy_amount must be a positive number",
      });
    }
    
    const sellAmount = buyAmount;
    sellAmountStr = sellAmount.toString();
    buyAmountStr = buy_amount as string;
    price = indicativeRate.toString();
  }
  
  try {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + QUOTE_EXPIRY_SECONDS;
    const quoteId = generateQuoteId();
    
    const quoteData: QuoteData = {
      id: quoteId,
      sellAsset,
      buyAsset,
      sellAmount: sellAmountStr,
      buyAmount: buyAmountStr,
      price,
      expiresAt,
      createdAt: now,
    };
    
    const tokenPayload: QuoteTokenPayload = {
      quoteId,
      sellAsset,
      buyAsset,
      sellAmount: sellAmountStr,
      buyAmount: buyAmountStr,
      price,
      expiresAt,
    };
    
    const quoteToken = jwt.sign(tokenPayload, getJwtSecret(), {
      expiresIn: QUOTE_EXPIRY_SECONDS,
    });
    
    await storeQuote(quoteData);
    
    return res.status(200).json({
      quote_id: quoteId,
      sell_asset: sellAsset,
      buy_asset: buyAsset,
      sell_amount: sellAmountStr,
      buy_amount: buyAmountStr,
      price: price,
      expires_at: new Date(expiresAt * 1000).toISOString(),
      quote_token: quoteToken,
    });
  } catch (error: any) {
    console.error("SEP-38 POST /quote error:", error);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Internal server error");
  }
});

export async function validateQuoteToken(quoteToken: string): Promise<QuoteData | null> {
  if (!quoteToken) return null;
  
  try {
    const secret = getJwtSecret();
    const decoded = jwt.verify(quoteToken, secret) as QuoteTokenPayload;
    
    const quote = await getQuote(decoded.quoteId);
    if (!quote) return null;
    
    const now = Math.floor(Date.now() / 1000);
    if (quote.expiresAt < now) {
      await deleteQuote(quote.id);
      return null;
    }
    
    return quote;
  } catch (error) {
    return null;
  }
}

export { QuoteData, QuoteTokenPayload };

export default router;