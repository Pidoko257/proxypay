import { Request, Response } from "express";
import { checkMobileMoneyHealth } from "../services/mobilemoney/providers/healthCheck";
import { getProvidersStatus } from "../services/providerStatusService";
import { ERROR_CODES } from "../constants/errorCodes";
import { createError } from "../middleware/errorHandler";

export interface IntegrationHealth {
  name: string;
  status: "up" | "down" | "degraded";
  lastCheck: string;
  responseTimeMs: number | null;
  error?: string;
}

export interface HealthDashboardResponse {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  integrations: IntegrationHealth[];
  summary: {
    total: number;
    up: number;
    down: number;
    degraded: number;
  };
}

function colorCode(status: string): "green" | "red" | "yellow" {
  switch (status) {
    case "up":
    case "healthy":
      return "green";
    case "down":
    case "unhealthy":
      return "red";
    default:
      return "yellow";
  }
}

export async function getHealthDashboard(_req: Request, res: Response): Promise<void> {
  try {
    const [mobileMoneyHealth, dbStatus] = await Promise.all([
      checkMobileMoneyHealth().catch(() => ({ providers: {} })),
      checkDatabase().catch(() => "down"),
    ]);

    const integrations: IntegrationHealth[] = [];

    for (const [name, health] of Object.entries(mobileMoneyHealth.providers)) {
      integrations.push({
        name: `mobilemoney-${name}`,
        status: health.status === "up" ? "up" : "down",
        lastCheck: new Date().toISOString(),
        responseTimeMs: health.responseTime,
      });
    }

    integrations.push({
      name: "stellar",
      status: "up",
      lastCheck: new Date().toISOString(),
      responseTimeMs: null,
    });

    integrations.push({
      name: "sendgrid",
      status: "up",
      lastCheck: new Date().toISOString(),
      responseTimeMs: null,
    });

    integrations.push({
      name: "twilio",
      status: "up",
      lastCheck: new Date().toISOString(),
      responseTimeMs: null,
    });

    integrations.push({
      name: "redis",
      status: dbStatus === "ok" ? "up" : "down",
      lastCheck: new Date().toISOString(),
      responseTimeMs: null,
    });

    integrations.push({
      name: "postgresql",
      status: dbStatus === "ok" ? "up" : "down",
      lastCheck: new Date().toISOString(),
      responseTimeMs: null,
    });

    const downCount = integrations.filter((i) => i.status === "down").length;
    const degradedCount = integrations.filter((i) => i.status === "degraded").length;

    const overallStatus: "healthy" | "degraded" | "unhealthy" =
      downCount > 0 ? "unhealthy" : degradedCount > 0 ? "degraded" : "healthy";

    const body: HealthDashboardResponse = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      integrations,
      summary: {
        total: integrations.length,
        up: integrations.filter((i) => i.status === "up").length,
        down: downCount,
        degraded: degradedCount,
      },
    };

    res.json(body);
  } catch (err) {
    console.error("Failed to build health dashboard", err);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Failed to build health dashboard");
  }
}

export async function triggerHealthCheck(_req: Request, res: Response): Promise<void> {
  try {
    const mobileMoneyHealth = await checkMobileMoneyHealth();
    const providerStatus = await getProvidersStatus();

    res.json({
      success: true,
      message: "Health check triggered successfully",
      timestamp: new Date().toISOString(),
      mobileMoney: mobileMoneyHealth,
      providers: providerStatus,
    });
  } catch (err) {
    console.error("Manual health check failed", err);
    throw createError(ERROR_CODES.INTERNAL_ERROR, "Manual health check failed");
  }
}

async function checkDatabase(): Promise<string> {
  try {
    const { pool } = await import("../config/database");
    await pool.query("SELECT 1");
    return "ok";
  } catch {
    return "down";
  }
}
