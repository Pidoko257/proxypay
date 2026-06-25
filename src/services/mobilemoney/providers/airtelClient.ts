/**
 * AirtelClient — typed OAuth2 client for Airtel Money Uganda / Tanzania.
 *
 * - Obtains client-credentials tokens via POST /auth/oauth2/token
 * - Caches the token in Redis; auto-refreshes 60 s before expiry
 * - Implements RequestToPay (collection) and Disburse (disbursement)
 * - Normalizes Airtel error codes to ProxyPay's error taxonomy
 */

import axios, { AxiosInstance } from "axios";
import { redisClient } from "../../../config/redis";
import { maskPII } from "../../../utils/masking";
import logger from "../../../utils/logger";
import { normalizeAirtelError } from "./airtelErrorMap";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AirtelClientConfig {
  baseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  country?: string;
  currency?: string;
  /** Seconds before token expiry to trigger a refresh. Default: 60. */
  refreshBufferSeconds?: number;
}

export interface RequestToPayParams {
  msisdn: string;
  amount: number;
  currency: string;
  reference: string;
  /** ISO 3166-1 alpha-2 country code of the subscriber */
  country: string;
}

export interface DisburseParams {
  msisdn: string;
  amount: number;
  currency: string;
  reference: string;
}

export interface AirtelTransactionResult {
  success: boolean;
  transactionId?: string;
  /** Normalized ProxyPay error code on failure */
  errorCode?: string;
  errorMessage?: string;
  /** Raw Airtel status code for debugging */
  rawStatus?: string;
}

export interface AirtelTransactionStatus {
  status: "completed" | "failed" | "pending" | "unknown";
  transactionId?: string;
  rawStatus?: string;
}

// Internal shape of the Airtel token response
interface TokenResponse {
  access_token: string;
  expires_in: number;
}

// Internal shape of the Airtel API response envelope
interface AirtelApiResponse {
  status?: { code?: string; success?: boolean; message?: string };
  data?: { transaction?: { id?: string; status?: string; airtel_money_id?: string } };
}

// ---------------------------------------------------------------------------
// Redis key
// ---------------------------------------------------------------------------

const TOKEN_CACHE_KEY = "airtel:oauth2:token";

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class AirtelClient {
  private readonly http: AxiosInstance;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly country: string;
  private readonly currency: string;
  private readonly refreshBufferSeconds: number;

  constructor(config: AirtelClientConfig = {}, httpClient?: AxiosInstance) {
    this.clientId     = config.clientId     ?? process.env.AIRTEL_CLIENT_ID     ?? process.env.AIRTEL_API_KEY    ?? "";
    this.clientSecret = config.clientSecret ?? process.env.AIRTEL_CLIENT_SECRET ?? process.env.AIRTEL_API_SECRET ?? "";
    this.country      = config.country      ?? process.env.AIRTEL_COUNTRY   ?? "UG";
    this.currency     = config.currency     ?? process.env.AIRTEL_CURRENCY  ?? "UGX";
    this.refreshBufferSeconds = config.refreshBufferSeconds ?? 60;

    this.http = httpClient ?? axios.create({
      baseURL: config.baseUrl ?? process.env.AIRTEL_BASE_URL ?? "https://openapi.airtel.africa",
      timeout: 30_000,
    });
  }

  // -------------------------------------------------------------------------
  // OAuth2 token management
  // -------------------------------------------------------------------------

  /** Returns a valid Bearer token, fetching or refreshing as needed. */
  async getAccessToken(): Promise<string> {
    const cached = await this.getCachedToken();
    if (cached) return cached;
    return this.fetchAndCacheToken();
  }

  private async getCachedToken(): Promise<string | null> {
    try {
      const raw = await redisClient.get(TOKEN_CACHE_KEY);
      if (raw) return raw;
    } catch {
      // Redis unavailable — fall through to fresh fetch
    }
    return null;
  }

  private async fetchAndCacheToken(): Promise<string> {
    const authHeader =
      "Basic " + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");

    const response = await this.http.post<TokenResponse>(
      "/auth/oauth2/token",
      { grant_type: "client_credentials" },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
      },
    );

    const { access_token, expires_in } = response.data;
    if (!access_token) throw new Error("Airtel OAuth2: no access_token in response");

    const ttl = Math.max(1, expires_in - this.refreshBufferSeconds);
    try {
      await redisClient.setEx(TOKEN_CACHE_KEY, ttl, access_token);
    } catch {
      // Non-fatal: token still works in-memory for this request
    }

    return access_token;
  }

  // -------------------------------------------------------------------------
  // RequestToPay (collection)
  // -------------------------------------------------------------------------

  async requestToPay(params: RequestToPayParams): Promise<AirtelTransactionResult> {
    logger.info(maskPII({ msisdn: params.msisdn, amount: params.amount }), "Airtel: RequestToPay");

    try {
      const token = await this.getAccessToken();
      const response = await this.http.post<AirtelApiResponse>(
        "/merchant/v1/payments/",
        {
          reference: params.reference,
          subscriber: {
            country:  params.country,
            currency: params.currency,
            msisdn:   params.msisdn,
          },
          transaction: {
            amount:   params.amount,
            country:  params.country,
            currency: params.currency,
            id:       params.reference,
          },
        },
        {
          headers: this.authHeaders(token),
        },
      );

      return this.parseResult(response.data);
    } catch (err: unknown) {
      return this.handleError("RequestToPay", err);
    }
  }

  // -------------------------------------------------------------------------
  // Disburse (disbursement / payout)
  // -------------------------------------------------------------------------

  async disburse(params: DisburseParams): Promise<AirtelTransactionResult> {
    logger.info(maskPII({ msisdn: params.msisdn, amount: params.amount }), "Airtel: Disburse");

    try {
      const token = await this.getAccessToken();
      const response = await this.http.post<AirtelApiResponse>(
        "/standard/v1/disbursements/",
        {
          reference: params.reference,
          payee: { msisdn: params.msisdn },
          transaction: {
            amount:   params.amount,
            currency: params.currency,
            id:       params.reference,
          },
        },
        {
          headers: this.authHeaders(token),
        },
      );

      return this.parseResult(response.data);
    } catch (err: unknown) {
      return this.handleError("Disburse", err);
    }
  }

  // -------------------------------------------------------------------------
  // Transaction status
  // -------------------------------------------------------------------------

  async getTransactionStatus(reference: string): Promise<AirtelTransactionStatus> {
    try {
      const token = await this.getAccessToken();
      const response = await this.http.get<AirtelApiResponse>(
        `/standard/v1/payments/${encodeURIComponent(reference)}`,
        { headers: this.authHeaders(token) },
      );

      const rawStatus = (response.data?.data?.transaction?.status ?? "").toUpperCase();
      return {
        transactionId: response.data?.data?.transaction?.id,
        rawStatus,
        status:
          rawStatus === "TS" ? "completed" :
          rawStatus === "TF" ? "failed" :
          rawStatus === "TP" ? "pending" :
          "unknown",
      };
    } catch {
      return { status: "unknown" };
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private authHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "X-Country":  this.country,
      "X-Currency": this.currency,
      "Content-Type": "application/json",
    };
  }

  private parseResult(body: AirtelApiResponse): AirtelTransactionResult {
    const code    = body.status?.code ?? "";
    const success = body.status?.success === true || code === "200";
    const txId    = body.data?.transaction?.id ?? body.data?.transaction?.airtel_money_id;

    if (success) {
      return { success: true, transactionId: txId, rawStatus: code };
    }

    return {
      success:      false,
      transactionId: txId,
      rawStatus:    code,
      errorCode:    normalizeAirtelError(code),
      errorMessage: body.status?.message,
    };
  }

  private handleError(operation: string, err: unknown): AirtelTransactionResult {
    const status = (err as { response?: { status?: number } })?.response?.status;
    const body   = (err as { response?: { data?: AirtelApiResponse } })?.response?.data;
    const airtelCode = body?.status?.code ?? status ?? "unknown";

    logger.error({ operation, airtelCode }, `Airtel: ${operation} failed`);

    return {
      success:      false,
      rawStatus:    String(airtelCode),
      errorCode:    normalizeAirtelError(airtelCode),
      errorMessage: body?.status?.message ?? (err instanceof Error ? err.message : String(err)),
    };
  }
}
