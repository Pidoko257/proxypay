import express, { Request, Response, NextFunction } from "express";
import webhookRoutes from "./routes/webhook";
import { config } from "./config/env";
import logger from "./logger";

// ── Shared typed error contract ─────────────────────────────────────────────
// Stable, machine-readable error codes. These codes are part of the public
// API contract and MUST NOT change across API versions.
export enum ErrorCode {
  BAD_REQUEST = "BAD_REQUEST",
  UNAUTHORIZED = "UNAUTHORIZED",
  FORBIDDEN = "FORBIDDEN",
  NOT_FOUND = "NOT_FOUND",
  CONFLICT = "CONFLICT",
  UNPROCESSABLE_ENTITY = "UNPROCESSABLE_ENTITY",
  INTERNAL_ERROR = "INTERNAL_ERROR",
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  [ErrorCode.BAD_REQUEST]: 400,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.UNPROCESSABLE_ENTITY]: 422,
  [ErrorCode.INTERNAL_ERROR]: 500,
};

export interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

// Expected domain error. Route handlers throw this and the shared error
// middleware maps it to a stable status code + machine-readable code.
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

// ── Operational health ──────────────────────────────────────────────────────
// Public callers only ever see a minimal overall state. Detailed provider /
// dependency diagnostics are gated behind admin authorization and audited.
export type HealthState = "ok" | "degraded" | "down";

export interface PublicHealth {
  status: HealthState;
}

export interface DependencyHealth {
  name: string;
  status: HealthState;
  latencyMs?: number;
  error?: string;
}

export interface DetailedHealth extends PublicHealth {
  uptimeSeconds: number;
  dependencies: DependencyHealth[];
}

// Pluggable dependency probe. Defaults to an empty set so the endpoint stays
// honest (no fabricated topology) until real probes are registered.
let dependencyProbes: Array<() => Promise<DependencyHealth>> = [];

export function registerDependencyProbe(
  probe: () => Promise<DependencyHealth>,
): void {
  dependencyProbes = [...dependencyProbes, probe];
}

async function collectDetailedHealth(): Promise<DetailedHealth> {
  const dependencies = await Promise.all(
    dependencyProbes.map(async (probe) => {
      try {
        return await probe();
      } catch (err) {
        return {
          name: "unknown",
          status: "down" as HealthState,
          error: err instanceof Error ? err.message : "probe failed",
        };
      }
    }),
  );

  const status: HealthState = dependencies.some((d) => d.status === "down")
    ? "down"
    : dependencies.some((d) => d.status === "degraded")
      ? "degraded"
      : "ok";

  return {
    status,
    uptimeSeconds: Math.floor(process.uptime()),
    dependencies,
  };
}

// Admin authorization for detailed diagnostics. Reuses the existing RBAC
// contract: callers must present an admin role via the authenticated request.
function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  const role = (req as any).user?.role ?? req.headers["x-user-role"];
  if (role !== "admin") {
    next(new ApiError(ErrorCode.FORBIDDEN, "Admin authorization required"));
    return;
  }
  next();
}

const app = express();

// Preserve raw request body buffer for signature verification middleware.
app.use(
  express.json({
    verify: (req: any, _res, buf: Buffer) => {
      req.rawBody = buf;
    },
  }),
);

// ── HTTP request / response logging ─────────────────────────────────────────
// Logs every inbound request and its outcome as a structured JSON line.
// Sensitive headers (Authorization, etc.) are redacted by the pino logger.
app.use((req: Request, res: Response, next: NextFunction) => {
  const startMs = Date.now();

  res.on("finish", () => {
    const durationMs = Date.now() - startMs;
    const level = res.statusCode >= 500 ? "error"
                : res.statusCode >= 400 ? "warn"
                : "info";

    logger[level](
      {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs,
        requestId: req.headers["x-request-id"] ?? undefined,
      },
      "HTTP request",
    );
  });

  next();
});

app.get("/", (_req: Request, res: Response) => {
  res.send("Bridge Starter API running 🚀");
});

// Public health: minimal overall state only — no topology or failure detail.
app.get("/health", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const detailed = await collectDetailedHealth();
    const body: PublicHealth = { status: detailed.status };
    res.status(detailed.status === "down" ? 503 : 200).json(body);
  } catch (err) {
    next(err);
  }
});

// Detailed diagnostics: admin-only, and every access is audit logged.
app.get(
  "/health/detailed",
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const detailed = await collectDetailedHealth();
      logger.info(
        {
          audit: "health.detailed.access",
          actor: (req as any).user?.id ?? req.headers["x-user-id"] ?? "unknown",
          requestId: req.headers["x-request-id"] ?? undefined,
          status: detailed.status,
        },
        "Detailed health diagnostics accessed",
      );
      res.status(detailed.status === "down" ? 503 : 200).json(detailed);
    } catch (err) {
      next(err);
    }
  },
);

app.use("/api", webhookRoutes);

// ── Shared error middleware ─────────────────────────────────────────────────
// Maps expected domain errors (ApiError) to their stable status + code, and
// falls back to a generic INTERNAL_ERROR for anything unexpected.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    const body: ErrorResponse = {
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    };
    res.status(err.status).json(body);
    return;
  }

  logger.error({ err }, "Unhandled error");
  const body: ErrorResponse = {
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message: "Internal server error",
    },
  };
  res.status(STATUS_BY_CODE[ErrorCode.INTERNAL_ERROR]).json(body);
});

app.listen(config.port, () => {
  logger.info({ port: config.port }, "Server started");
});
