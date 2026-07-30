/**
 * OpenAPI Generator Extensions for Deprecation Support
 *
 * Enhances the OpenAPI schema generator to include deprecation metadata
 * and automatically mark endpoints as deprecated in the OpenAPI spec.
 */

import { ZodSchema } from "zod";
import { getDeprecatedEndpoints, getDeprecationTimeline } from "./deprecation";

/**
 * OpenAPI deprecation metadata
 */
export interface OpenAPIDeprecation {
  deprecated: true;
  "x-sunset-date": string;
  "x-alternative-endpoint"?: string;
  "x-migration-guide"?: string;
  "x-deprecation-reason"?: string;
}

/**
 * Extend OpenAPI spec with deprecation info
 */
export function addDeprecationToOpenAPISpec(spec: Record<string, any>): void {
  const deprecated = getDeprecatedEndpoints();

  // Update paths with deprecation info
  for (const path of Object.keys(spec.paths || {})) {
    for (const method of Object.keys(spec.paths[path])) {
      if (method === "parameters" || method === "servers") continue;

      // Check if this endpoint is deprecated
      for (const item of deprecated) {
        const methodUpper = item.method.toUpperCase();
        if (
          spec.paths[path][method.toLowerCase()] &&
          item.path === path &&
          item.method === methodUpper
        ) {
          const operation = spec.paths[path][method.toLowerCase()];
          operation.deprecated = true;
          operation.description = operation.description || "";

          // Append deprecation notice to description
          const sunsetDate = new Date(item.metadata.sunsetDate);
          const daysUntilSunset = Math.floor(
            (sunsetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
          );

          operation.description += `

**⚠️ DEPRECATED** - This endpoint will be sunset on ${sunsetDate.toISOString().split("T")[0]} (${daysUntilSunset} days from now).`;

          if (item.metadata.reason) {
            operation.description += `\n**Reason:** ${item.metadata.reason}`;
          }

          if (item.metadata.alternativeEndpoint) {
            operation.description += `\n**Use instead:** \`${item.metadata.alternativeEndpoint}\``;
          }

          if (item.metadata.migrationGuide) {
            operation.description += `\n**[Migration Guide](${item.metadata.migrationGuide})**: Detailed migration instructions.`;
          }

          // Add extension headers
          operation["x-sunset-date"] = sunsetDate.toISOString();
          if (item.metadata.alternativeEndpoint) {
            operation["x-alternative-endpoint"] = item.metadata.alternativeEndpoint;
          }
          if (item.metadata.migrationGuide) {
            operation["x-migration-guide"] = item.metadata.migrationGuide;
          }
          if (item.metadata.reason) {
            operation["x-deprecation-reason"] = item.metadata.reason;
          }
        }
      }
    }
  }

  // Add deprecation timeline to spec info
  const timeline = getDeprecationTimeline();
  spec.info.description = spec.info.description || "";
  spec.info.description += `

## Deprecation Notice

${timeline.length > 0 ? "The following endpoints are scheduled for deprecation:\n\n" : "No deprecations scheduled."}`;

  for (const item of timeline) {
    const sunsetDate = item.date.toISOString().split("T")[0];
    spec.info.description += `- **${sunsetDate}** (${item.endpointCount} endpoint${item.endpointCount > 1 ? "s" : ""})\n`;
  }
}

/**
 * Create deprecation warning headers for responses
 */
export function createDeprecationHeaders(
  method: string,
  path: string,
): Record<string, string | undefined> {
  const deprecatedEndpoints = getDeprecatedEndpoints();
  const endpoint = deprecatedEndpoints.find((e) => e.method === method && e.path === path);

  if (!endpoint) {
    return {};
  }

  const headers: Record<string, string | undefined> = {
    Deprecation: "true",
    Sunset: new Date(endpoint.metadata.sunsetDate).toUTCString(),
  };

  if (endpoint.metadata.alternativeEndpoint) {
    headers["X-API-Alternative-Endpoint"] = endpoint.metadata.alternativeEndpoint;
  }
  if (endpoint.metadata.migrationGuide) {
    headers["X-API-Migration-Guide"] = endpoint.metadata.migrationGuide;
  }
  if (endpoint.metadata.reason) {
    headers["X-API-Deprecation-Reason"] = endpoint.metadata.reason;
  }

  return headers;
}

/**
 * Generate deprecation section for API documentation
 */
export function generateDeprecationDocumentation(): string {
  const deprecated = getDeprecatedEndpoints();
  const timeline = getDeprecationTimeline();

  let doc = "# API Deprecation Policy\n\n";

  doc += "## Overview\n";
  doc += "ProxyPay follows a clear deprecation policy to ensure stability and provide ample notice for client migration.\n\n";

  doc += "## Deprecation Timeline\n\n";
  for (const item of timeline) {
    const sunsetDate = item.date.toISOString().split("T")[0];
    doc += `### ${sunsetDate}\n`;
    doc += `${item.endpointCount} endpoint${item.endpointCount > 1 ? "s" : ""} will be removed.\n`;
    doc += "```\n";
    for (const endpoint of item.endpoints) {
      doc += `${endpoint}\n`;
    }
    doc += "```\n\n";
  }

  doc += "## Active Deprecations\n\n";
  for (const item of deprecated) {
    const sunsetDate = new Date(item.metadata.sunsetDate);
    doc += `### ${item.endpoint}\n`;
    doc += `- **Status:** Deprecated\n`;
    doc += `- **Sunset Date:** ${sunsetDate.toISOString()}\n`;
    if (item.metadata.reason) {
      doc += `- **Reason:** ${item.metadata.reason}\n`;
    }
    if (item.metadata.alternativeEndpoint) {
      doc += `- **Alternative:** \`${item.metadata.alternativeEndpoint}\`\n`;
    }
    if (item.metadata.migrationGuide) {
      doc += `- **[Migration Guide](${item.metadata.migrationGuide})\`\n`;
    }
    doc += "\n";
  }

  doc += "## Response Headers\n\n";
  doc += "All deprecated endpoints include the following response headers:\n\n";
  doc += "```\n";
  doc += "Deprecation: true\n";
  doc += "Sunset: <RFC-2822 date>\n";
  doc += "X-API-Alternative-Endpoint: <new endpoint>\n";
  doc += "X-API-Migration-Guide: <URL to migration docs>\n";
  doc += "X-API-Deprecation-Reason: <reason for deprecation>\n";
  doc += "```\n\n";

  doc += "## Migration Steps\n\n";
  doc += "1. Check the response headers for the recommended alternative endpoint\n";
  doc += "2. Refer to the migration guide linked in `X-API-Migration-Guide`\n";
  doc += "3. Update your client code to use the new endpoint\n";
  doc += "4. Test thoroughly before the sunset date\n";
  doc += "5. Update to the latest SDK version if available\n";

  return doc;
}
