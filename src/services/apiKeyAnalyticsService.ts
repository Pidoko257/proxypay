
import { pool, queryRead } from "../config/database";
import { redisClient } from "../config/redis";

const CACHE_TTL = 3600; // 1 hour in seconds

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

export async function getApiKeyAnalytics(
  apiKeyId: string,
  startDate?: Date,
  endDate?: Date,
): Promise<{
  dailyStats: Array<{ date: string; totalRequests: number; errorRate: number }>;
  topEndpoints: Array<{ path: string; requestCount: number }>;
  latency: { p50: number; p95: number; p99: number };
}> {
  // Check cache
  const cacheKey = `api_key_analytics:${apiKeyId}`;
  if (redisClient?.isOpen) {
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
  }

  // Default start date is 30 days ago
  const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const end = endDate || new Date();

  // Daily stats query
  const dailyStatsResult = await queryRead(
    `
      SELECT
        DATE(created_at) as date,
        COUNT(*) as total_requests,
        SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as error_count
      FROM request_logs
      WHERE api_key_id = $1
        AND created_at >= $2
        AND created_at <= $3
      GROUP BY DATE(created_at)
      ORDER BY date
    `,
    [apiKeyId, start, end],
  );

  const dailyStats = dailyStatsResult.rows.map((row) => ({
    date: row.date.toISOString().split("T")[0],
    totalRequests: Number(row.total_requests),
    errorRate:
      row.total_requests > 0 ? Number(row.error_count) / Number(row.total_requests) : 0,
  }));

  // Top endpoints
  const topEndpointsResult = await queryRead(
    `
      SELECT
        path,
        COUNT(*) as request_count
      FROM request_logs
      WHERE api_key_id = $1
        AND created_at >= $2
        AND created_at <= $3
      GROUP BY path
      ORDER BY request_count DESC
      LIMIT 5
    `,
    [apiKeyId, start, end],
  );

  const topEndpoints = topEndpointsResult.rows.map((row) => ({
    path: row.path,
    requestCount: Number(row.request_count),
  }));

  // Latency percentiles
  const latencyResult = await queryRead(
    `
      SELECT latency_ms
      FROM request_logs
      WHERE api_key_id = $1
        AND created_at >= $2
        AND created_at <= $3
    `,
    [apiKeyId, start, end],
  );

  const latencies = latencyResult.rows.map((row) => Number(row.latency_ms));
  const latency = {
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
  };

  const analytics = {
    dailyStats,
    topEndpoints,
    latency,
  };

  // Cache the result
  if (redisClient?.isOpen) {
    await redisClient.set(cacheKey, JSON.stringify(analytics), { EX: CACHE_TTL });
  }

  return analytics;
}

