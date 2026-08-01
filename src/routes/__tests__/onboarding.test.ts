import request from "supertest";
import express from "express";
import { onboardingRoutes } from "../onboarding";
import { OnboardingService } from "../../services/onboardingService";
import { errorHandler } from "../../middleware/errorHandler";

jest.mock("../../services/onboardingService");
jest.mock("../../middleware/auth");

const mockService = OnboardingService as jest.MockedClass<typeof OnboardingService>;
const authModule = jest.mocked(require("../../middleware/auth"));

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/onboarding", onboardingRoutes);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: auth passes through with a user
  authModule.requireAuth.mockImplementation((req: any, _res: any, next: any) => {
    req.user = { id: "user-123", role: "user" };
    next();
  });
});

describe("Onboarding Routes", () => {
  // ── POST /api/onboarding/account ──────────────────────────────────────────

  describe("POST /api/onboarding/account", () => {
    it("should create user and org with step 1 data", async () => {
      mockService.prototype.createAccount.mockResolvedValue({
        user: { id: "user-123", email: "dev@example.com" },
        organization: { id: "org-456", name: "Acme Labs" },
        token: "jwt-token",
      });

      const res = await request(makeApp())
        .post("/api/onboarding/account")
        .send({
          email: "dev@example.com",
          password: "Str0ng!Pass#12",
          phone_number: "+237670000000",
          org_name: "Acme Labs",
        });

      expect(res.status).toBe(201);
      expect(res.body.message).toBe("Account created successfully");
      expect(res.body.data.user.id).toBe("user-123");
      expect(res.body.data.organization.name).toBe("Acme Labs");
      expect(res.body.data.token).toBe("jwt-token");
    });

    it("should return 400 if email is missing", async () => {
      const res = await request(makeApp())
        .post("/api/onboarding/account")
        .send({
          password: "Str0ng!Pass#12",
          phone_number: "+237670000000",
          org_name: "Acme Labs",
        });

      expect(res.status).toBe(400);
      expect(res.body.details).toBeDefined();
    });

    it("should return 400 if password is too short", async () => {
      const res = await request(makeApp())
        .post("/api/onboarding/account")
        .send({
          email: "dev@example.com",
          password: "short",
          phone_number: "+237670000000",
          org_name: "Acme Labs",
        });

      expect(res.status).toBe(400);
    });

    it("should return 400 if org_name is empty", async () => {
      const res = await request(makeApp())
        .post("/api/onboarding/account")
        .send({
          email: "dev@example.com",
          password: "Str0ng!Pass#12",
          phone_number: "+237670000000",
          org_name: "",
        });

      expect(res.status).toBe(400);
    });

    it("should return 400 if phone_number is missing", async () => {
      const res = await request(makeApp())
        .post("/api/onboarding/account")
        .send({
          email: "dev@example.com",
          password: "Str0ng!Pass#12",
          org_name: "Acme Labs",
        });

      expect(res.status).toBe(400);
    });

    it("should return 500 when service throws", async () => {
      mockService.prototype.createAccount.mockRejectedValue(
        new Error("Role 'user' not found"),
      );

      const res = await request(makeApp())
        .post("/api/onboarding/account")
        .send({
          email: "dev@example.com",
          password: "Str0ng!Pass#12",
          phone_number: "+237670000000",
          org_name: "Acme Labs",
        });

      expect(res.status).toBe(500);
    });
  });

  // ── PATCH /api/onboarding/business ────────────────────────────────────────

  describe("PATCH /api/onboarding/business", () => {
    it("should update business info and return 200", async () => {
      mockService.prototype.updateBusinessInfo.mockResolvedValue({
        organization: { id: "org-456", business_name: "Acme Labs Ltd" },
      });

      const res = await request(makeApp())
        .patch("/api/onboarding/business")
        .send({
          business_name: "Acme Labs Ltd",
          business_type: "startup",
        });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Business information updated successfully");
      expect(res.body.data.organization).toBeDefined();
      expect(mockService.prototype.updateBusinessInfo).toHaveBeenCalledWith("user-123", {
        business_name: "Acme Labs Ltd",
        business_type: "startup",
      });
    });

    it("should require authentication", async () => {
      authModule.requireAuth.mockImplementation((_req: any, res: any, _next: any) => {
        res.status(401).json({ error: "Unauthorized" });
      });

      const res = await request(makeApp())
        .patch("/api/onboarding/business")
        .send({ business_name: "Acme Labs Ltd", business_type: "startup" });

      expect(res.status).toBe(401);
    });

    it("should return 400 if business_name is missing", async () => {
      const res = await request(makeApp())
        .patch("/api/onboarding/business")
        .send({ business_type: "startup" });

      expect(res.status).toBe(400);
    });

    it("should return 400 if business_type is missing", async () => {
      const res = await request(makeApp())
        .patch("/api/onboarding/business")
        .send({ business_name: "Acme Labs Ltd" });

      expect(res.status).toBe(400);
    });

    it("should return 400 if website is not a valid URL", async () => {
      const res = await request(makeApp())
        .patch("/api/onboarding/business")
        .send({
          business_name: "Acme Labs Ltd",
          business_type: "startup",
          website: "not-a-url",
        });

      expect(res.status).toBe(400);
    });

    it("should return 400 if country is not 2 letters", async () => {
      const res = await request(makeApp())
        .patch("/api/onboarding/business")
        .send({
          business_name: "Acme Labs Ltd",
          business_type: "startup",
          country: "NGA",
        });

      expect(res.status).toBe(400);
    });

    it("should allow optional fields to be omitted", async () => {
      mockService.prototype.updateBusinessInfo.mockResolvedValue({
        organization: { id: "org-456" },
      });

      const res = await request(makeApp())
        .patch("/api/onboarding/business")
        .send({ business_name: "Acme Labs Ltd", business_type: "startup" });

      expect(res.status).toBe(200);
    });

    it("should return 500 when service throws", async () => {
      mockService.prototype.updateBusinessInfo.mockRejectedValue(
        new Error("Step 1 must be completed before updating business info"),
      );

      const res = await request(makeApp())
        .patch("/api/onboarding/business")
        .send({
          business_name: "Acme Labs Ltd",
          business_type: "startup",
        });

      expect(res.status).toBe(500);
    });
  });

  // ── PATCH /api/onboarding/use-case ────────────────────────────────────────

  describe("PATCH /api/onboarding/use-case", () => {
    it("should store use cases and return 200", async () => {
      mockService.prototype.setUseCases.mockResolvedValue({
        use_cases: ["payments", "marketplace"],
      });

      const res = await request(makeApp())
        .patch("/api/onboarding/use-case")
        .send({ use_cases: ["payments", "marketplace"] });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Use cases updated successfully");
      expect(res.body.data.use_cases).toEqual(["payments", "marketplace"]);
      expect(mockService.prototype.setUseCases).toHaveBeenCalledWith("user-123", {
        use_cases: ["payments", "marketplace"],
      });
    });

    it("should require authentication", async () => {
      authModule.requireAuth.mockImplementation((_req: any, res: any, _next: any) => {
        res.status(401).json({ error: "Unauthorized" });
      });

      const res = await request(makeApp())
        .patch("/api/onboarding/use-case")
        .send({ use_cases: ["payments"] });

      expect(res.status).toBe(401);
    });

    it("should return 400 if use_cases is empty", async () => {
      const res = await request(makeApp())
        .patch("/api/onboarding/use-case")
        .send({ use_cases: [] });

      expect(res.status).toBe(400);
    });

    it("should return 400 if use_cases is missing", async () => {
      const res = await request(makeApp())
        .patch("/api/onboarding/use-case")
        .send({});

      expect(res.status).toBe(400);
    });

    it("should return 400 for invalid use case values", async () => {
      const res = await request(makeApp())
        .patch("/api/onboarding/use-case")
        .send({ use_cases: ["invalid_case", "payments"] });

      expect(res.status).toBe(400);
    });

    it("should accept all valid use case values", async () => {
      mockService.prototype.setUseCases.mockResolvedValue({
        use_cases: ["payments", "marketplace", "remittances", "charity", "payroll", "other"],
      });

      const res = await request(makeApp())
        .patch("/api/onboarding/use-case")
        .send({
          use_cases: ["payments", "marketplace", "remittances", "charity", "payroll", "other"],
        });

      expect(res.status).toBe(200);
    });

    it("should return 500 when service throws", async () => {
      mockService.prototype.setUseCases.mockRejectedValue(
        new Error("Step 2 must be completed before setting use cases"),
      );

      const res = await request(makeApp())
        .patch("/api/onboarding/use-case")
        .send({ use_cases: ["payments"] });

      expect(res.status).toBe(500);
    });
  });

  // ── GET /api/onboarding/status ────────────────────────────────────────────

  describe("GET /api/onboarding/status", () => {
    it("should return current step and completion status", async () => {
      mockService.prototype.getStatus.mockResolvedValue({
        current_step: 2,
        completed: false,
        steps: {
          account: true,
          business: true,
          use_case: false,
          email_verification: false,
        },
        completed_at: null,
      });

      const res = await request(makeApp()).get("/api/onboarding/status");

      expect(res.status).toBe(200);
      expect(res.body.data.current_step).toBe(2);
      expect(res.body.data.completed).toBe(false);
      expect(res.body.data.steps.account).toBe(true);
      expect(res.body.data.steps.business).toBe(true);
      expect(res.body.data.steps.use_case).toBe(false);
      expect(res.body.data.steps.email_verification).toBe(false);
      expect(mockService.prototype.getStatus).toHaveBeenCalledWith("user-123");
    });

    it("should require authentication", async () => {
      authModule.requireAuth.mockImplementation((_req: any, res: any, _next: any) => {
        res.status(401).json({ error: "Unauthorized" });
      });

      const res = await request(makeApp()).get("/api/onboarding/status");

      expect(res.status).toBe(401);
    });

    it("should return step 0 for new user with no progress", async () => {
      mockService.prototype.getStatus.mockResolvedValue({
        current_step: 0,
        completed: false,
        steps: {
          account: false,
          business: false,
          use_case: false,
          email_verification: false,
        },
        completed_at: null,
      });

      const res = await request(makeApp()).get("/api/onboarding/status");

      expect(res.status).toBe(200);
      expect(res.body.data.current_step).toBe(0);
      expect(res.body.data.completed).toBe(false);
      expect(res.body.data.steps.account).toBe(false);
    });

    it("should return completed status when all steps are done", async () => {
      mockService.prototype.getStatus.mockResolvedValue({
        current_step: 4,
        completed: true,
        steps: {
          account: true,
          business: true,
          use_case: true,
          email_verification: true,
        },
        completed_at: new Date("2026-07-26T10:00:00Z"),
      });

      const res = await request(makeApp()).get("/api/onboarding/status");

      expect(res.status).toBe(200);
      expect(res.body.data.completed).toBe(true);
      expect(res.body.data.completed_at).toBeDefined();
    });
  });
});
