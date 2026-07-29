/**
 * OpenAPI Spec Management
 * 
 * Utilities for fetching, caching, and managing OpenAPI specifications.
 * Includes support for multiple spec versions and server configurations.
 */

/**
 * OpenAPI spec metadata
 */
export interface SpecMetadata {
  title: string;
  version: string;
  description?: string;
  contact?: {
    name?: string;
    url?: string;
    email?: string;
  };
  license?: {
    name: string;
    url?: string;
  };
}

/**
 * API tag information
 */
export interface ApiTag {
  name: string;
  description?: string;
  externalDocs?: {
    description?: string;
    url?: string;
  };
}

/**
 * Operation information
 */
export interface ApiOperation {
  operationId: string;
  summary: string;
  description?: string;
  method: 'get' | 'post' | 'put' | 'patch' | 'delete' | 'options' | 'head';
  path: string;
  tags?: string[];
  parameters?: Record<string, any>[];
  requestBody?: any;
  responses?: Record<string, any>;
  deprecated?: boolean;
  security?: any[];
}

/**
 * Cached spec entry
 */
interface CachedSpec {
  spec: Record<string, any>;
  timestamp: number;
  etag?: string;
}

/**
 * In-memory cache for OpenAPI specs
 */
const specCache = new Map<string, CachedSpec>();
const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check if cached spec is still valid
 */
function isCacheValid(entry: CachedSpec): boolean {
  return Date.now() - entry.timestamp < CACHE_DURATION_MS;
}

/**
 * Fetch OpenAPI specification with caching support
 */
export async function fetchOpenAPISpec(
  url: string,
  options?: { 
    skipCache?: boolean;
    forceRefresh?: boolean;
  }
): Promise<Record<string, any>> {
  const skipCache = options?.skipCache ?? false;
  const forceRefresh = options?.forceRefresh ?? false;

  // Check cache first
  if (!skipCache && !forceRefresh) {
    const cached = specCache.get(url);
    if (cached && isCacheValid(cached)) {
      console.debug(`[OpenAPI] Using cached spec from ${url}`);
      return cached.spec;
    }
  }

  try {
    console.debug(`[OpenAPI] Fetching spec from ${url}`);

    const headers: Record<string, string> = {
      'Accept': 'application/json, application/yaml',
    };

    // Add ETag if we have it from a previous request
    const cached = specCache.get(url);
    if (cached?.etag) {
      headers['If-None-Match'] = cached.etag;
    }

    const response = await fetch(url, {
      method: 'GET',
      headers,
      cache: forceRefresh ? 'no-store' : 'force-cache',
    });

    // Handle 304 Not Modified
    if (response.status === 304 && cached) {
      console.debug(`[OpenAPI] Spec not modified (304), using cached version`);
      cached.timestamp = Date.now();
      return cached.spec;
    }

    if (!response.ok) {
      throw new Error(
        `Failed to fetch OpenAPI spec: ${response.status} ${response.statusText}`
      );
    }

    // Get content type and parse accordingly
    const contentType = response.headers.get('content-type') || '';
    let spec: Record<string, any>;

    if (contentType.includes('yaml')) {
      // YAML parsing would require external library
      throw new Error('YAML specs require additional parsing library');
    } else {
      spec = await response.json();
    }

    // Validate spec has required fields
    if (!spec.openapi && !spec.swagger) {
      throw new Error('Invalid OpenAPI spec: missing openapi/swagger version');
    }

    // Store in cache with ETag
    const etag = response.headers.get('etag') || undefined;
    specCache.set(url, {
      spec,
      timestamp: Date.now(),
      etag,
    });

    console.debug(`[OpenAPI] Spec cached for ${url}`);
    return spec;
  } catch (error) {
    console.error(`[OpenAPI] Error fetching spec from ${url}:`, error);
    throw error;
  }
}

/**
 * Extract metadata from OpenAPI spec
 */
export function extractMetadata(spec: Record<string, any>): SpecMetadata {
  const info = spec.info || {};
  return {
    title: info.title || 'API Reference',
    version: info.version || '1.0.0',
    description: info.description,
    contact: info.contact,
    license: info.license,
  };
}

/**
 * Extract tags from OpenAPI spec
 */
export function extractTags(spec: Record<string, any>): ApiTag[] {
  const tags = spec.tags || [];
  return tags.map((tag: Record<string, any>) => ({
    name: tag.name,
    description: tag.description,
    externalDocs: tag.externalDocs,
  }));
}

/**
 * Extract operations from OpenAPI spec organized by tag
 */
export function extractOperationsByTag(
  spec: Record<string, any>
): Record<string, ApiOperation[]> {
  const paths = spec.paths || {};
  const operations: Record<string, ApiOperation[]> = {};

  for (const [path, pathItem] of Object.entries(paths)) {
    const path_methods = pathItem as Record<string, any>;

    for (const [method, operation] of Object.entries(path_methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(method)) {
        continue;
      }

      const op = operation as Record<string, any>;
      const operationId = op.operationId || `${method.toUpperCase()}_${path}`;
      const tags = op.tags || ['Uncategorized'];

      const apiOp: ApiOperation = {
        operationId,
        summary: op.summary || 'No summary',
        description: op.description,
        method: method as any,
        path,
        tags,
        parameters: op.parameters,
        requestBody: op.requestBody,
        responses: op.responses,
        deprecated: op.deprecated,
        security: op.security,
      };

      // Add to each tag's list
      for (const tag of tags) {
        if (!operations[tag]) {
          operations[tag] = [];
        }
        operations[tag].push(apiOp);
      }
    }
  }

  // Sort operations within each tag
  for (const tag in operations) {
    operations[tag].sort((a, b) => a.path.localeCompare(b.path));
  }

  return operations;
}

/**
 * Get all operations flattened
 */
export function extractAllOperations(spec: Record<string, any>): ApiOperation[] {
  const operationsByTag = extractOperationsByTag(spec);
  const seen = new Set<string>();
  const operations: ApiOperation[] = [];

  for (const ops of Object.values(operationsByTag)) {
    for (const op of ops) {
      if (!seen.has(op.operationId)) {
        operations.push(op);
        seen.add(op.operationId);
      }
    }
  }

  return operations;
}

/**
 * Search operations by various criteria
 */
export function searchOperations(
  spec: Record<string, any>,
  query: string
): ApiOperation[] {
  const lowerQuery = query.toLowerCase();
  const operations = extractAllOperations(spec);

  return operations.filter((op) => {
    return (
      op.operationId.toLowerCase().includes(lowerQuery) ||
      op.summary.toLowerCase().includes(lowerQuery) ||
      op.description?.toLowerCase().includes(lowerQuery) ||
      op.path.toLowerCase().includes(lowerQuery) ||
      op.tags?.some((tag) => tag.toLowerCase().includes(lowerQuery))
    );
  });
}

/**
 * Get operation details by operation ID
 */
export function getOperation(
  spec: Record<string, any>,
  operationId: string
): ApiOperation | null {
  const operations = extractAllOperations(spec);
  return operations.find((op) => op.operationId === operationId) || null;
}

/**
 * Generate code example for an operation
 */
export function generateCodeExample(
  operation: ApiOperation,
  language: 'curl' | 'javascript' | 'python' = 'curl',
  baseUrl: string = 'https://api.proxypay.app'
): string {
  const url = `${baseUrl}${operation.path}`;

  if (language === 'curl') {
    const method = operation.method.toUpperCase();
    let curl = `curl -X ${method} '${url}'`;

    if (operation.parameters) {
      curl += ` \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer YOUR_TOKEN'`;
    }

    if (operation.requestBody) {
      curl += ` \\
  -d '{
    "key": "value"
  }'`;
    }

    return curl;
  }

  if (language === 'javascript') {
    const method = operation.method.toUpperCase();
    let js = `const response = await fetch('${url}', {
  method: '${method}',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer YOUR_TOKEN',
  },`;

    if (operation.requestBody) {
      js += `
  body: JSON.stringify({
    key: 'value',
  }),`;
    }

    js += `
});

const data = await response.json();
console.log(data);`;

    return js;
  }

  if (language === 'python') {
    const method = operation.method.lower();
    let python = `import requests

response = requests.${method}(
  '${url}',
  headers={
    'Content-Type': 'application/json',
    'Authorization': 'Bearer YOUR_TOKEN',
  },`;

    if (operation.requestBody) {
      python += `
  json={
    'key': 'value',
  },`;
    }

    python += `
)

print(response.json())`;

    return python;
  }

  return '';
}

/**
 * Clear spec cache
 */
export function clearSpecCache(url?: string): void {
  if (url) {
    specCache.delete(url);
    console.debug(`[OpenAPI] Cleared cache for ${url}`);
  } else {
    specCache.clear();
    console.debug('[OpenAPI] Cleared all spec cache');
  }
}

/**
 * Get cache statistics
 */
export function getSpecCacheStats(): {
  size: number;
  entries: string[];
  oldestEntry?: { url: string; age: number };
} {
  const entries = Array.from(specCache.entries());
  let oldestEntry: { url: string; age: number } | undefined;

  for (const [url, cache] of entries) {
    const age = Date.now() - cache.timestamp;
    if (!oldestEntry || age > oldestEntry.age) {
      oldestEntry = { url, age };
    }
  }

  return {
    size: specCache.size,
    entries: entries.map(([url]) => url),
    oldestEntry,
  };
}

/**
 * Preload spec to warm cache
 */
export async function preloadSpec(url: string): Promise<void> {
  try {
    await fetchOpenAPISpec(url);
    console.debug(`[OpenAPI] Preloaded spec from ${url}`);
  } catch (error) {
    console.warn(`[OpenAPI] Failed to preload spec from ${url}:`, error);
  }
}

/**
 * Export spec as JSON
 */
export function exportSpec(spec: Record<string, any>, filename?: string): void {
  const json = JSON.stringify(spec, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename || 'openapi-spec.json';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default {
  fetchOpenAPISpec,
  extractMetadata,
  extractTags,
  extractOperationsByTag,
  extractAllOperations,
  searchOperations,
  getOperation,
  generateCodeExample,
  clearSpecCache,
  getSpecCacheStats,
  preloadSpec,
  exportSpec,
};
