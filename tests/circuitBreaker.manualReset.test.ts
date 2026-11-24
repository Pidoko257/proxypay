import express, { Request, Response, NextFunction } from "express";
import request from "supertest";

let mockUser: { id: string; role: string } | null = { id: "admin_tester_123", role: "admin" };

jest.mock("../src/middleware/auth", () => ({
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    if (!mockUser) {
      return res.status(401).json({ error: "Unauthorized", message: "Authentication required" });
    }
    (req as any).user = mockUser;
    (req as any).jwtUser = { userId: mockUser.id };
    next();
  },
}));

jest.mock("../src/middleware/rbac", () => ({
  requireAdmin: (req: Request, res: Response, next: NextFunction) => {
    const role = (req as any).user?.role || (req as any).userRole;
    if (role !== "admin") {
      return res.status(403).json({ error: "Forbidden", message: "Admin role required" });
    }
    next();
  },
}));

jest.mock("../src/utils/log-audit-event", () => ({
  logAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

import providerCircuitBreakerRoutes from "../src/routes/providerCircuitBreakerRoutes";
import * as circuitBreakerUtils from "../src/utils/circuitBreaker";
import * as auditModule from "../src/utils/log-audit-event";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin/circuit-breaker", providerCircuitBreakerRoutes);
  return app;
}

describe("Provider Circuit Breaker Manual Reset Control (Issue #678)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: "admin_tester_123", role: "admin" };
  });

  describe("Status inspection", () => {
    it("returns active circuit breakers status across all providers", async () => {
      const res = await request(buildApp()).get("/api/v1/admin/circuit-breaker/status");
      expect(res.status).toBe(200);
      expect(res.body.providers).toBeDefined();
      expect(res.body.providers.mtn).toBeDefined();
      expect(res.body.providers.airtel).toBeDefined();
      expect(res.body.providers.orange).toBeDefined();
    });

    it("returns status for a single provider", async () => {
      const res = await request(buildApp()).get("/api/v1/admin/circuit-breaker/mtn/status");
      expect(res.status).toBe(200);
      expect(res.body.provider).toBe("mtn");
      expect(res.body.operations).toBeDefined();
    });

    it("rejects invalid provider status queries with 400", async () => {
      const res = await request(buildApp()).get("/api/v1/admin/circuit-breaker/invalid_provider/status");
      expect(res.status).toBe(400);
    });
  });

  describe("Manual Reset Control", () => {
    it("resets circuit breaker for a provider via URL parameter", async () => {
      const resetSpy = jest.spyOn(circuitBreakerUtils, "resetCircuitBreakerForProvider");

      const res = await request(buildApp())
        .post("/api/v1/admin/circuit-breaker/mtn/reset")
        .send({ reason: "Upstream MTN MoMo gateway outage resolved" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.provider).toBe("mtn");
      expect(res.body.resetBy).toBe("admin_tester_123");
      expect(res.body.reason).toBe("Upstream MTN MoMo gateway outage resolved");

      expect(resetSpy).toHaveBeenCalledWith("mtn");
      expect(auditModule.logAuditEvent).toHaveBeenCalledWith(
        "admin_tester_123",
        "CIRCUIT_BREAKER_MANUAL_RESET",
        expect.objectContaining({
          extra: expect.objectContaining({
            provider: "mtn",
            reason: "Upstream MTN MoMo gateway outage resolved",
          }),
        })
      );
    });

    it("resets a specific operation when specified in body", async () => {
      const resetOpSpy = jest.spyOn(circuitBreakerUtils, "resetCircuitBreaker");

      const res = await request(buildApp())
        .post("/api/v1/admin/circuit-breaker/airtel/reset")
        .send({ operation: "payment", reason: "Payment channel restored" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.provider).toBe("airtel");
      expect(res.body.operation).toBe("payment");

      expect(resetOpSpy).toHaveBeenCalledWith("airtel", "payment");
      expect(auditModule.logAuditEvent).toHaveBeenCalledWith(
        "admin_tester_123",
        "CIRCUIT_BREAKER_MANUAL_RESET",
        expect.objectContaining({
          extra: expect.objectContaining({
            provider: "airtel",
            operation: "payment",
          }),
        })
      );
    });

    it("resets all providers when provider is 'all'", async () => {
      const resetSpy = jest.spyOn(circuitBreakerUtils, "resetCircuitBreakerForProvider");

      const res = await request(buildApp())
        .post("/api/v1/admin/circuit-breaker/all/reset")
        .send({ reason: "Cluster maintenance completed" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.provider).toBe("all");

      expect(resetSpy).toHaveBeenCalledWith("mtn");
      expect(resetSpy).toHaveBeenCalledWith("airtel");
      expect(resetSpy).toHaveBeenCalledWith("orange");
    });

    it("supports POST /reset with provider in JSON body", async () => {
      const resetSpy = jest.spyOn(circuitBreakerUtils, "resetCircuitBreakerForProvider");

      const res = await request(buildApp())
        .post("/api/v1/admin/circuit-breaker/reset")
        .send({ provider: "orange", reason: "Orange Money SMS notification lag fixed" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.provider).toBe("orange");
      expect(resetSpy).toHaveBeenCalledWith("orange");
    });

    it("rejects unknown provider reset requests with 400", async () => {
      const res = await request(buildApp())
        .post("/api/v1/admin/circuit-breaker/bad_provider/reset")
        .send();

      expect(res.status).toBe(400);
    });
  });

  describe("RBAC Protection", () => {
    it("rejects non-admin users with 403 Forbidden", async () => {
      mockUser = { id: "user_normal", role: "merchant" };

      const res = await request(buildApp())
        .post("/api/v1/admin/circuit-breaker/mtn/reset")
        .send();

      expect(res.status).toBe(403);
    });

    it("rejects unauthenticated requests with 401 Unauthorized", async () => {
      mockUser = null;

      const res = await request(buildApp())
        .post("/api/v1/admin/circuit-breaker/mtn/reset")
        .send();

      expect(res.status).toBe(401);
    });
  });
});