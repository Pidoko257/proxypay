
import { Request, Response, NextFunction } from "express";
import { pool } from "../config/database";

export function requestLoggerMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const start = Date.now();

  // Hook into response finish
  res.on("finish", async () => {
    const apiKeyId = (req as any).apiKeyId;
    if (!apiKeyId) {
      return; // Only log requests with API keys
    }

    const latencyMs = Date.now() - start;
    try {
      await pool.query(
        `INSERT INTO request_logs (api_key_id, method, path, status_code, latency_ms)
         VALUES ($1, $2, $3, $4, $5)`,
        [apiKeyId, req.method, req.originalUrl, res.statusCode, latencyMs],
      );
    } catch (err) {
      console.error("[requestLogger] Failed to log request:", err);
    }
  });

  next();
}

