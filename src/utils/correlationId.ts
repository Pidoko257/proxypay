/**
 * Correlation ID utility for distributed tracing and request tracking
 * Generates unique identifiers to track requests across services
 */

/**
 * Generates a correlation ID for distributed request tracing
 * Format: 8-4-4-4-12 (UUID-like but optimized for tracing)
 */
export function generateCorrelationId(): string {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 10);
  const processId = process.pid.toString(36).padStart(4, "0");
  return `corr-${timestamp}-${randomPart}-${processId}`;
}

/**
 * Extracts correlation ID from request headers or generates a new one
 */
export function getOrGenerateCorrelationId(
  headers: Record<string, string | undefined>
): string {
  const existing = headers["x-correlation-id"];
  if (existing && isValidCorrelationId(existing)) {
    return existing;
  }
  return generateCorrelationId();
}

/**
 * Validates a correlation ID format
 */
export function isValidCorrelationId(id: string): boolean {
  return /^corr-[a-z0-9]{4,}-[a-z0-9]{4,}-[a-z0-9]{4,}$/.test(id);
}

/**
 * Extracts correlation ID for logging context
 */
export interface CorrelationContext {
  correlationId: string;
  timestamp: string;
}

export function createContext(headers: Record<string, string | undefined>): CorrelationContext {
  return {
    correlationId: getOrGenerateCorrelationId(headers),
    timestamp: new Date().toISOString(),
  };
}