import { Request, Response, NextFunction } from "express";
import { queryWrite } from "../config/database";

// List of sensitive paths to exclude from logging
const EXCLUDED_PATHS = ["/health", "/health/lb", "/ready", "/metrics"];

export const requestLogger = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Skip logging for excluded paths
  if (EXCLUDED_PATHS.some((path) => req.path.startsWith(path))) {
    return next();
  }

  const startTime = Date.now();
  const requestId = (req as any).id;
  const method = req.method;
  const path = req.originalUrl;
  const ipAddress = req.ip || (req as any).connection?.remoteAddress;
  const userAgent = req.get("user-agent");

  // Capture response finish event
  res.on("finish", async () => {
    try {
      const durationMs = Date.now() - startTime;
      const statusCode = res.statusCode;
      const userId = (req as any).user?.id;
      const apiKeyId = (req as any).apiKey?.id;

      // Log asynchronously, don't block
      await queryWrite(
        `INSERT INTO request_logs (
          request_id, method, path, status_code, duration_ms, 
          api_key_id, user_id, ip_address, user_agent
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          requestId,
          method,
          path,
          statusCode,
          durationMs,
          apiKeyId,
          userId,
          ipAddress,
          userAgent,
        ]
      );
    } catch (error) {
      // If logging fails, just log to console but don't throw
      console.error("Failed to log request to database:", error);
    }
  });

  next();
};
