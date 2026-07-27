/**
 * Database Query Interceptor
 *
 * Hooks into database queries to automatically log execution metrics.
 * Supports PostgreSQL pools and provides comprehensive monitoring.
 */

import { Pool, QueryConfig, QueryResult, QueryResultRow } from "pg";
import { QueryLoggerService } from "./queryLoggerService";
import { QueryLog, QueryType, QueryStatus, QueryContext } from "./types";
import logger from "../../utils/logger";

/**
 * Extract query type from SQL statement
 */
function extractQueryType(query: string): QueryType {
  const normalized = query.trim().toUpperCase();

  if (normalized.startsWith("SELECT")) return QueryType.SELECT;
  if (normalized.startsWith("INSERT")) return QueryType.INSERT;
  if (normalized.startsWith("UPDATE")) return QueryType.UPDATE;
  if (normalized.startsWith("DELETE")) return QueryType.DELETE;
  if (normalized.startsWith("BEGIN") || normalized.startsWith("COMMIT"))
    return QueryType.TRANSACTION;
  if (
    normalized.startsWith("CREATE") ||
    normalized.startsWith("ALTER") ||
    normalized.startsWith("DROP")
  )
    return QueryType.DDL;

  return QueryType.OTHER;
}

/**
 * Extract table names from query
 */
function extractTables(query: string): string[] {
  const tables: string[] = [];

  // Common patterns: FROM table, INTO table, UPDATE table, DELETE FROM table
  const patterns = [
    /FROM\s+(\w+)/gi,
    /INTO\s+(\w+)/gi,
    /UPDATE\s+(\w+)/gi,
    /JOIN\s+(\w+)/gi,
    /TABLE\s+(\w+)/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(query)) !== null) {
      tables.push(match[1].toLowerCase());
    }
  }

  return [...new Set(tables)]; // Remove duplicates
}

/**
 * Check if query is read-only
 */
function isReadOnlyQuery(query: string): boolean {
  const normalized = query.trim().toUpperCase();
  return normalized.startsWith("SELECT");
}

/**
 * Sanitize query for logging (remove sensitive data)
 */
function sanitizeQuery(query: string, maxLength: number = 1000): string {
  let sanitized = query;

  // Remove or replace sensitive patterns
  sanitized = sanitized.replace(/('([^']*)')/g, "'***'"); // String literals
  sanitized = sanitized.replace(/(\d{10,})/g, "***"); // Long numbers (phone, card)
  sanitized = sanitized.replace(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, "***@***"); // Emails

  // Truncate if too long
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength) + "...";
  }

  return sanitized;
}

/**
 * Database query interceptor for logging
 */
export class QueryInterceptor {
  private queryLogger: QueryLoggerService | null = null;
  private currentContext: QueryContext = {};

  constructor(queryLogger: QueryLoggerService) {
    this.queryLogger = queryLogger;
  }

  /**
   * Set current query context
   */
  setContext(context: QueryContext): void {
    this.currentContext = context;
  }

  /**
   * Clear current context
   */
  clearContext(): void {
    this.currentContext = {};
  }

  /**
   * Wrap a query execution with logging
   */
  async executeWithLogging<T extends QueryResultRow = any>(
    query: string | QueryConfig,
    params?: any[],
    executor: () => Promise<QueryResult<T>>
  ): Promise<QueryResult<T>> {
    const startTime = process.hrtime.bigint();
    const queryString = typeof query === "string" ? query : query.text;
    const queryParams = typeof query === "string" ? params : query.values;

    let result: QueryResult<T>;
    let error: Error | null = null;
    let status: QueryStatus = QueryStatus.SUCCESS;

    try {
      result = await executor();

      // Check result status (some databases return errors in result)
      if (!result) {
        error = new Error("No result returned");
        status = QueryStatus.FAILED;
      }
    } catch (err) {
      error = err as Error;
      status = QueryStatus.FAILED;
      throw err;
    } finally {
      // Record query log
      const endTime = process.hrtime.bigint();
      const durationNs = Number(endTime - startTime);
      const durationMs = durationNs / 1e6;

      try {
        const queryLog: QueryLog = {
          id: "",
          timestamp: Date.now(),
          timestampISO: new Date().toISOString(),
          query: sanitizeQuery(queryString),
          queryType: extractQueryType(queryString),
          table: extractTables(queryString)[0],
          tables: extractTables(queryString),
          durationMs: Math.round(durationMs * 100) / 100,
          durationNs,
          status,
          rowsAffected: result?.rowCount || undefined,
          rowsReturned: result?.rows?.length || undefined,
          isReadOnly: isReadOnlyQuery(queryString),
          userId: this.currentContext.userId,
          sessionId: this.currentContext.sessionId,
          correlationId: this.currentContext.correlationId,
          source: this.currentContext.source,
          tags: this.currentContext.tags,
          error: error
            ? {
                code: (error as any).code,
                message: error.message,
                severity: (error as any).severity,
              }
            : undefined,
          version: 1,
        };

        // Log the query
        await this.queryLogger?.logQuery(queryLog);
      } catch (logError) {
        logger.error("Failed to log query", { logError });
      }
    }

    return result;
  }
}

/**
 * Create an intercepted PostgreSQL pool
 */
export function createInterceptedPool(
  pool: Pool,
  queryLogger: QueryLoggerService
): Pool {
  const interceptor = new QueryInterceptor(queryLogger);

  // Override the query method
  const originalQuery = pool.query.bind(pool);

  pool.query = async function <T extends QueryResultRow = any>(
    queryConfig: QueryConfig | string,
    values?: any
  ): Promise<QueryResult<T>> {
    return interceptor.executeWithLogging<T>(
      queryConfig,
      values,
      () => originalQuery(queryConfig, values) as Promise<QueryResult<T>>
    );
  };

  return pool;
}

/**
 * Set query context for current request (use in middleware)
 */
export function createQueryContextMiddleware(
  getQueryLogger: () => QueryLoggerService | null
) {
  return (req: any, _res: any, next: any) => {
    const queryLogger = getQueryLogger();

    if (!queryLogger) {
      return next();
    }

    // Store queryLogger in request for later use
    req.queryLogger = queryLogger;

    // Set context from request
    if (req.user || req.headers["x-correlation-id"]) {
      // Note: This would need to be properly integrated with your interceptor
      // For now, just pass it through
    }

    next();
  };
}

/**
 * Execute query with logging context
 */
export async function executeQueryWithContext<T = any>(
  pool: Pool,
  queryLogger: QueryLoggerService,
  query: string,
  params: any[] = [],
  context?: QueryContext
): Promise<T[]> {
  const interceptor = new QueryInterceptor(queryLogger);

  if (context) {
    interceptor.setContext(context);
  }

  try {
    const result = await interceptor.executeWithLogging(
      query,
      params,
      () => pool.query(query, params)
    );

    return (result.rows || []) as T[];
  } finally {
    interceptor.clearContext();
  }
}

/**
 * Execute multiple queries with transaction logging
 */
export async function executeTransactionWithLogging<T = any>(
  pool: Pool,
  queryLogger: QueryLoggerService,
  queries: Array<{ query: string; params?: any[] }>,
  context?: QueryContext
): Promise<T[][]> {
  const client = await pool.connect();
  const interceptor = new QueryInterceptor(queryLogger);

  if (context) {
    interceptor.setContext(context);
  }

  try {
    const results: T[][] = [];

    // Begin transaction
    await interceptor.executeWithLogging(
      "BEGIN",
      undefined,
      () => client.query("BEGIN")
    );

    // Execute queries
    for (const q of queries) {
      const result = await interceptor.executeWithLogging(
        q.query,
        q.params,
        () => client.query(q.query, q.params)
      );

      results.push((result.rows || []) as T[]);
    }

    // Commit transaction
    await interceptor.executeWithLogging(
      "COMMIT",
      undefined,
      () => client.query("COMMIT")
    );

    return results;
  } catch (error) {
    // Rollback on error
    try {
      await interceptor.executeWithLogging(
        "ROLLBACK",
        undefined,
        () => client.query("ROLLBACK")
      );
    } catch (rollbackError) {
      logger.error("Failed to rollback transaction", { rollbackError });
    }

    throw error;
  } finally {
    interceptor.clearContext();
    client.release();
  }
}
