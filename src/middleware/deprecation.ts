/**
 * OpenAPI Deprecation Warnings
 *
 * Marks deprecated API endpoints with:
 * - Sunset header (RFC 8594)
 * - Deprecation header (RFC 9110)
 * - Deprecation notice in OpenAPI docs
 * - Migration guidance
 */

import { Request, Response, NextFunction } from "express";
import { logger } from "../services/loggers";

/**
 * Deprecation metadata for an endpoint
 */
export interface DeprecationMetadata {
  deprecated: true;
  sunsetDate: Date; // When the endpoint will be removed
  alternativeEndpoint?: string; // New endpoint to use instead
  migrationGuide?: string; // Link to migration documentation
  reason?: string; // Why it was deprecated
}

/**
 * Registry of deprecated endpoints
 */
const deprecatedEndpoints: Map<string, DeprecationMetadata> = new Map();

/**
 * Mark an endpoint as deprecated
 */
export function markEndpointDeprecated(
  method: string,
  path: string,
  metadata: DeprecationMetadata,
): void {
  const key = `${method} ${path}`;
  deprecatedEndpoints.set(key, metadata);
  logger.info("Endpoint marked as deprecated", {
    endpoint: key,
    sunsetDate: metadata.sunsetDate.toISOString(),
    alternative: metadata.alternativeEndpoint,
  });
}

/**
 * Check if an endpoint is deprecated
 */
export function isEndpointDeprecated(method: string, path: string): DeprecationMetadata | undefined {
  const key = `${method} ${path}`;
  return deprecatedEndpoints.get(key);
}

/**
 * Get all deprecated endpoints
 */
export function getDeprecatedEndpoints(): Array<{
  endpoint: string;
  method: string;
  path: string;
  metadata: DeprecationMetadata;
}> {
  return Array.from(deprecatedEndpoints.entries()).map(([endpoint, metadata]) => {
    const [method, path] = endpoint.split(" ");
    return { endpoint, method, path, metadata };
  });
}

/**
 * Middleware to add deprecation headers to responses
 */
export function deprecationHeadersMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const deprecation = isEndpointDeprecated(req.method, req.path);

  if (deprecation) {
    // Set deprecation header (RFC 9110)
    res.set("Deprecation", "true");

    // Set sunset header (RFC 8594) - when the endpoint will be removed
    const sunsetDate = new Date(deprecation.sunsetDate);
    res.set("Sunset", sunsetDate.toUTCString());

    // Custom headers for migration guidance
    if (deprecation.alternativeEndpoint) {
      res.set("X-API-Alternative-Endpoint", deprecation.alternativeEndpoint);
    }

    if (deprecation.migrationGuide) {
      res.set("X-API-Migration-Guide", deprecation.migrationGuide);
    }

    if (deprecation.reason) {
      res.set("X-API-Deprecation-Reason", deprecation.reason);
    }

    // Log the deprecation access
    logger.warn("Deprecated endpoint accessed", {
      method: req.method,
      path: req.path,
      ip: req.ip,
      userAgent: req.get("user-agent"),
      sunsetDate: sunsetDate.toISOString(),
      alternative: deprecation.alternativeEndpoint,
    });
  }

  next();
}

/**
 * Generate OpenAPI deprecation annotation for Zod schemas
 */
export function withDeprecation(description: string): string {
  return `[DEPRECATED] ${description}`;
}

/**
 * Deprecation configuration for API endpoints
 */
export const DEPRECATED_ENDPOINTS = {
  // Transaction endpoints
  "GET /api/v1/transactions": {
    deprecated: true,
    sunsetDate: new Date("2027-01-01"),
    alternativeEndpoint: "GET /api/v2/transactions",
    migrationGuide: "https://docs.proxypay.local/migration/v1-to-v2",
    reason: "Use v2 API for enhanced filtering and pagination",
  },

  "POST /api/v1/transactions/deposit": {
    deprecated: true,
    sunsetDate: new Date("2027-01-01"),
    alternativeEndpoint: "POST /api/v2/transactions/deposit",
    migrationGuide: "https://docs.proxypay.local/migration/v1-to-v2",
    reason: "v2 API provides improved error handling and response format",
  },

  "POST /api/v1/transactions/withdraw": {
    deprecated: true,
    sunsetDate: new Date("2027-01-01"),
    alternativeEndpoint: "POST /api/v2/transactions/withdraw",
    migrationGuide: "https://docs.proxypay.local/migration/v1-to-v2",
    reason: "v2 API provides improved error handling and response format",
  },

  // KYC endpoints
  "GET /api/v1/kyc/status": {
    deprecated: true,
    sunsetDate: new Date("2027-03-01"),
    alternativeEndpoint: "GET /api/v2/kyc/verification-status",
    migrationGuide: "https://docs.proxypay.local/migration/kyc-v1-to-v2",
    reason: "Response format changed to include additional verification fields",
  },

  "POST /api/v1/kyc/submit": {
    deprecated: true,
    sunsetDate: new Date("2027-03-01"),
    alternativeEndpoint: "POST /api/v2/kyc/verify",
    migrationGuide: "https://docs.proxypay.local/migration/kyc-v1-to-v2",
    reason: "New endpoint supports more document types and verification methods",
  },

  // Dispute endpoints
  "GET /api/v1/disputes": {
    deprecated: true,
    sunsetDate: new Date("2027-02-01"),
    alternativeEndpoint: "GET /api/v2/disputes",
    migrationGuide: "https://docs.proxypay.local/migration/disputes-v1-to-v2",
    reason: "v2 includes advanced filtering and sorting options",
  },

  // Vault endpoints (old format)
  "POST /api/v1/vaults/transfer": {
    deprecated: true,
    sunsetDate: new Date("2027-04-01"),
    alternativeEndpoint: "POST /api/v2/vaults/:id/operations",
    migrationGuide: "https://docs.proxypay.local/migration/vaults-v1-to-v2",
    reason: "Consolidated endpoint for all vault operations",
  },
};

/**
 * Register all deprecated endpoints in the deprecation registry
 */
export function registerDeprecatedEndpoints(): void {
  for (const [endpoint, metadata] of Object.entries(DEPRECATED_ENDPOINTS)) {
    const [method, path] = endpoint.split(" ");
    markEndpointDeprecated(method, path, metadata as DeprecationMetadata);
  }

  logger.info("Deprecated endpoints registered", {
    count: Object.keys(DEPRECATED_ENDPOINTS).length,
  });
}

/**
 * Get deprecation timeline as a summary
 */
export function getDeprecationTimeline(): Array<{
  date: Date;
  daysSinceNow: number;
  endpointCount: number;
  endpoints: string[];
}> {
  const timeline = new Map<string, Array<{method: string; path: string}>>();

  for (const [endpoint, metadata] of deprecatedEndpoints.entries()) {
    const dateStr = metadata.sunsetDate.toISOString().split("T")[0];
    if (!timeline.has(dateStr)) {
      timeline.set(dateStr, []);
    }

    const [method, path] = endpoint.split(" ");
    timeline.get(dateStr)!.push({ method, path });
  }

  return Array.from(timeline.entries())
    .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
    .map(([dateStr, endpoints]) => {
      const date = new Date(dateStr);
      const now = new Date();
      const daysSinceNow = Math.floor((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

      return {
        date,
        daysSinceNow,
        endpointCount: endpoints.length,
        endpoints: endpoints.map((e) => `${e.method} ${e.path}`),
      };
    });
}

/**
 * Generate deprecation report for documentation
 */
export function generateDeprecationReport(): string {
  const deprecated = getDeprecatedEndpoints();
  const timeline = getDeprecationTimeline();

  let report = "# API Deprecation Report\n\n";
  report += `**Generated:** ${new Date().toISOString()}\n\n`;

  report += "## Deprecation Timeline\n\n";
  for (const item of timeline) {
    report += `### ${item.date.toISOString().split("T")[0]} (${item.daysSinceNow} days from now)\n`;
    report += `**Endpoints being removed:** ${item.endpointCount}\n\n`;
    for (const endpoint of item.endpoints) {
      report += `- \`${endpoint}\`\n`;
    }
    report += "\n";
  }

  report += "## Deprecated Endpoints\n\n";
  for (const item of deprecated) {
    report += `### ${item.endpoint}\n`;
    report += `**Reason:** ${item.metadata.reason || "N/A"}\n`;
    report += `**Sunset Date:** ${item.metadata.sunsetDate.toISOString()}\n`;
    if (item.metadata.alternativeEndpoint) {
      report += `**Use Instead:** \`${item.metadata.alternativeEndpoint}\`\n`;
    }
    if (item.metadata.migrationGuide) {
      report += `**Migration Guide:** ${item.metadata.migrationGuide}\n`;
    }
    report += "\n";
  }

  return report;
}
