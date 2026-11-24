/**
 * Provider-Specific Compatibility Bridges
 *
 * Implements detailed compatibility mappings for real-world API differences
 * between v1 and v2 of each provider (MTN, Airtel, Orange).
 */

import { ProviderApiVersion, CompatibilityMapping } from "./types";
import { CompatibilityAdapter } from "./adapter";
import logger from "../../../utils/logger";

/**
 * Request/response types for MTN APIs
 */
interface MTNv1Request {
  phone_number: string;
  amount: string;
  external_id: string;
  currency?: string;
  callback_url?: string;
}

interface MTNv2Request {
  phoneNumber: string;
  amount: number;
  externalId: string;
  currency: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
}

interface MTNv1Response {
  transaction_id: string;
  status: string;
  amount: string;
}

interface MTNv2Response {
  transactionId: string;
  status: string;
  amount: number;
  metadata?: Record<string, unknown>;
}

/**
 * MTN compatibility bridge
 */
export class MTNCompatibilityBridge {
  static registerMappings(adapter: CompatibilityAdapter): void {
    // MTN v1 -> v2
    adapter.registerMapping({
      sourceVersion: ProviderApiVersion.V1,
      targetVersion: ProviderApiVersion.V2,
      requestMapper: MTNCompatibilityBridge.mapRequestV1ToV2,
      responseMapper: MTNCompatibilityBridge.mapResponseV2ToV1,
    });

    // MTN v2 -> v1
    adapter.registerMapping({
      sourceVersion: ProviderApiVersion.V2,
      targetVersion: ProviderApiVersion.V1,
      requestMapper: MTNCompatibilityBridge.mapRequestV2ToV1,
      responseMapper: MTNCompatibilityBridge.mapResponseV1ToV2,
    });

    logger.info("Registered MTN compatibility mappings");
  }

  /**
   * V1 request with string amounts -> V2 request with numeric amounts
   */
  private static mapRequestV1ToV2(request: unknown): MTNv2Request {
    const v1Req = request as MTNv1Request;

    return {
      phoneNumber: v1Req.phone_number,
      amount: Number.parseFloat(v1Req.amount),
      externalId: v1Req.external_id,
      currency: v1Req.currency || "XAF",
      callbackUrl: v1Req.callback_url,
      metadata: {
        source: "v1_migration",
        originalRequest: JSON.stringify(v1Req),
      },
    };
  }

  /**
   * V2 response back to V1 format
   */
  private static mapResponseV2ToV1(response: unknown): MTNv1Response {
    const v2Res = response as MTNv2Response;

    return {
      transaction_id: v2Res.transactionId,
      status: v2Res.status,
      amount: v2Res.amount.toString(),
    };
  }

  /**
   * V2 request -> V1 request (fallback scenario)
   */
  private static mapRequestV2ToV1(request: unknown): MTNv1Request {
    const v2Req = request as MTNv2Request;

    return {
      phone_number: v2Req.phoneNumber,
      amount: v2Req.amount.toString(),
      external_id: v2Req.externalId,
      currency: v2Req.currency,
      callback_url: v2Req.callbackUrl,
    };
  }

  /**
   * V1 response back to V2 format
   */
  private static mapResponseV1ToV2(response: unknown): MTNv2Response {
    const v1Res = response as MTNv1Response;

    return {
      transactionId: v1Res.transaction_id,
      status: v1Res.status,
      amount: Number.parseFloat(v1Res.amount),
      metadata: {
        source: "v1_fallback",
      },
    };
  }
}

/**
 * Request/response types for Airtel APIs
 */
interface Airtelv1Request {
  msisdn: string;
  amount: string;
  reference: string;
  pin?: string;
}

interface Airtelv2Request {
  customer: {
    msisdn: string;
  };
  transaction: {
    amount: number;
    currency: string;
    id: string;
  };
  pin?: string;
}

interface Airtelv1Response {
  data: {
    transaction_id: string;
    message: string;
  };
  status: boolean;
}

interface Airtelv2Response {
  id: string;
  status: "success" | "failed" | "pending";
  created_at: string;
}

/**
 * Airtel compatibility bridge
 */
export class AirtelCompatibilityBridge {
  static registerMappings(adapter: CompatibilityAdapter): void {
    // Airtel v1 -> v2
    adapter.registerMapping({
      sourceVersion: ProviderApiVersion.V1,
      targetVersion: ProviderApiVersion.V2,
      requestMapper: AirtelCompatibilityBridge.mapRequestV1ToV2,
      responseMapper: AirtelCompatibilityBridge.mapResponseV2ToV1,
    });

    // Airtel v2 -> v1
    adapter.registerMapping({
      sourceVersion: ProviderApiVersion.V2,
      targetVersion: ProviderApiVersion.V1,
      requestMapper: AirtelCompatibilityBridge.mapRequestV2ToV1,
      responseMapper: AirtelCompatibilityBridge.mapResponseV1ToV2,
    });

    logger.info("Registered Airtel compatibility mappings");
  }

  /**
   * V1 flat structure -> V2 nested structure
   */
  private static mapRequestV1ToV2(request: unknown): Airtelv2Request {
    const v1Req = request as Airtelv1Request;

    return {
      customer: {
        msisdn: v1Req.msisdn,
      },
      transaction: {
        amount: Number.parseFloat(v1Req.amount),
        currency: "XAF",
        id: v1Req.reference,
      },
      pin: v1Req.pin,
    };
  }

  /**
   * V2 response back to V1 format
   */
  private static mapResponseV2ToV1(response: unknown): Airtelv1Response {
    const v2Res = response as Airtelv2Response;

    return {
      data: {
        transaction_id: v2Res.id,
        message: v2Res.status === "success" ? "Transaction successful" : v2Res.status,
      },
      status: v2Res.status === "success",
    };
  }

  /**
   * V2 request -> V1 request (fallback)
   */
  private static mapRequestV2ToV1(request: unknown): Airtelv1Request {
    const v2Req = request as Airtelv2Request;

    return {
      msisdn: v2Req.customer.msisdn,
      amount: v2Req.transaction.amount.toString(),
      reference: v2Req.transaction.id,
      pin: v2Req.pin,
    };
  }

  /**
   * V1 response back to V2 format
   */
  private static mapResponseV1ToV2(response: unknown): Airtelv2Response {
    const v1Res = response as Airtelv1Response;

    return {
      id: v1Res.data.transaction_id,
      status: v1Res.status ? "success" : "failed",
      created_at: new Date().toISOString(),
    };
  }
}

/**
 * Request/response types for Orange APIs
 */
interface Orangev1Request {
  number: string;
  amount: string;
  txnid: string;
}

interface Orangev2Request {
  party_id: string;
  amount: number;
  request_id: string;
}

interface Orangev1Response {
  code: string;
  description: string;
  txnid: string;
}

interface Orangev2Response {
  request_id: string;
  status_code: number;
  status_description: string;
}

/**
 * Orange compatibility bridge
 */
export class OrangeCompatibilityBridge {
  static registerMappings(adapter: CompatibilityAdapter): void {
    // Orange v1 -> v2
    adapter.registerMapping({
      sourceVersion: ProviderApiVersion.V1,
      targetVersion: ProviderApiVersion.V2,
      requestMapper: OrangeCompatibilityBridge.mapRequestV1ToV2,
      responseMapper: OrangeCompatibilityBridge.mapResponseV2ToV1,
    });

    // Orange v2 -> v1
    adapter.registerMapping({
      sourceVersion: ProviderApiVersion.V2,
      targetVersion: ProviderApiVersion.V1,
      requestMapper: OrangeCompatibilityBridge.mapRequestV2ToV1,
      responseMapper: OrangeCompatibilityBridge.mapResponseV1ToV2,
    });

    logger.info("Registered Orange compatibility mappings");
  }

  /**
   * V1 format -> V2 format
   */
  private static mapRequestV1ToV2(request: unknown): Orangev2Request {
    const v1Req = request as Orangev1Request;

    return {
      party_id: v1Req.number,
      amount: Number.parseFloat(v1Req.amount),
      request_id: v1Req.txnid,
    };
  }

  /**
   * V2 response back to V1 format
   */
  private static mapResponseV2ToV1(response: unknown): Orangev1Response {
    const v2Res = response as Orangev2Response;

    return {
      code: v2Res.status_code.toString(),
      description: v2Res.status_description,
      txnid: v2Res.request_id,
    };
  }

  /**
   * V2 request -> V1 request (fallback)
   */
  private static mapRequestV2ToV1(request: unknown): Orangev1Request {
    const v2Req = request as Orangev2Request;

    return {
      number: v2Req.party_id,
      amount: v2Req.amount.toString(),
      txnid: v2Req.request_id,
    };
  }

  /**
   * V1 response back to V2 format
   */
  private static mapResponseV1ToV2(response: unknown): Orangev2Response {
    const v1Res = response as Orangev1Response;

    return {
      request_id: v1Res.txnid,
      status_code: Number.parseInt(v1Res.code, 10),
      status_description: v1Res.description,
    };
  }
}

/**
 * Register all provider-specific compatibility bridges
 */
export function registerAllCompatibilityBridges(
  adapter: CompatibilityAdapter
): void {
  MTNCompatibilityBridge.registerMappings(adapter);
  AirtelCompatibilityBridge.registerMappings(adapter);
  OrangeCompatibilityBridge.registerMappings(adapter);
  logger.info("Registered all provider compatibility bridges");
}
