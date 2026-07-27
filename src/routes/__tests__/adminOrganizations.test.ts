import request from "supertest";
import express from "express";
import { adminRoutes } from "../admin";

jest.mock("../../controllers/admin/organizationController");
jest.mock("../../config/redis", () => ({
  redisClient: {
    isOpen: true,
    ping: jest.fn().mockResolvedValue("PONG"),
  },
}));

describe("Admin Organization Endpoints", () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    app.use((req, _res, next) => {
      (req as any).user = { id: "super-admin-123", role: "super-admin" };
      next();
    });

    app.use("/api/admin", adminRoutes);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /api/admin/organizations", () => {
    it("should list organizations with pagination and search", async () => {
      const response = await request(app)
        .get("/api/admin/organizations")
        .expect(200);

      expect(response.body.data).toBeDefined();
    });

    it("should require super-admin role", async () => {
      const appWithoutSuperAdmin = express();
      appWithoutSuperAdmin.use(express.json());
      appWithoutSuperAdmin.use((req, _res, next) => {
        (req as any).user = { id: "admin-123", role: "admin" };
        next();
      });
      appWithoutSuperAdmin.use("/api/admin", adminRoutes);

      const response = await request(appWithoutSuperAdmin)
        .get("/api/admin/organizations")
        .expect(403);

      expect(response.body.error).toBe("Forbidden");
    });
  });

  describe("GET /api/admin/organizations/:id", () => {
    it("should get a single organization by ID", async () => {
      const response = await request(app)
        .get("/api/admin/organizations/org-1")
        .expect(200);

      expect(response.body).toBeDefined();
    });

    it("should return 404 for non-existent organization", async () => {
      const { createError } = require("../../middleware/errorHandler");
      const { ERROR_CODES } = require("../../constants/errorCodes");

      (require("../../controllers/admin/organizationController") as any)
        .getOrganization = (_req: any, _res: any, next: any) => {
          throw createError(ERROR_CODES.NOT_FOUND, "Organization not found", {
            message: "Organization not found",
          });
        };

      const response = await request(app)
        .get("/api/admin/organizations/non-existent")
        .expect(404);

      expect(response.body.error).toBe("Not Found");
    });
  });

  describe("PATCH /api/admin/organizations/:id/suspend", () => {
    it("should suspend an organization and disable its API keys", async () => {
      const response = await request(app)
        .patch("/api/admin/organizations/org-1/suspend")
        .send({ reason: "Policy violation" })
        .expect(200);

      expect(response.body.message).toBe("Organization suspended successfully");
      expect(response.body.apiKeysDisabled).toBe(true);
    });

    it("should require super-admin role", async () => {
      const appWithoutSuperAdmin = express();
      appWithoutSuperAdmin.use(express.json());
      appWithoutSuperAdmin.use((req, _res, next) => {
        (req as any).user = { id: "admin-123", role: "admin" };
        next();
      });
      appWithoutSuperAdmin.use("/api/admin", adminRoutes);

      const response = await request(appWithoutSuperAdmin)
        .patch("/api/admin/organizations/org-1/suspend")
        .send({ reason: "Policy violation" })
        .expect(403);

      expect(response.body.error).toBe("Forbidden");
    });

    it("should return 404 for non-existent organization", async () => {
      const { createError } = require("../../middleware/errorHandler");
      const { ERROR_CODES } = require("../../constants/errorCodes");

      (require("../../controllers/admin/organizationController") as any)
        .suspendOrganization = (_req: any, _res: any, next: any) => {
          throw createError(ERROR_CODES.NOT_FOUND, "Organization not found", {
            message: "Organization not found",
          });
        };

      const response = await request(app)
        .patch("/api/admin/organizations/non-existent/suspend")
        .send({ reason: "Policy violation" })
        .expect(404);

      expect(response.body.error).toBe("Not Found");
    });
  });

  describe("DELETE /api/admin/organizations/:id", () => {
    it("should initiate async deletion of an organization", async () => {
      const response = await request(app)
        .delete("/api/admin/organizations/org-1")
        .expect(200);

      expect(response.body.message).toBe(
        "Organization deletion initiated. A confirmation email will be sent upon completion.",
      );
      expect(response.body.status).toBe("cleanup_queued");
    });

    it("should require super-admin role", async () => {
      const appWithoutSuperAdmin = express();
      appWithoutSuperAdmin.use(express.json());
      appWithoutSuperAdmin.use((req, _res, next) => {
        (req as any).user = { id: "admin-123", role: "admin" };
        next();
      });
      appWithoutSuperAdmin.use("/api/admin", adminRoutes);

      const response = await request(appWithoutSuperAdmin)
        .delete("/api/admin/organizations/org-1")
        .expect(403);

      expect(response.body.error).toBe("Forbidden");
    });

    it("should return 404 for non-existent organization", async () => {
      const { createError } = require("../../middleware/errorHandler");
      const { ERROR_CODES } = require("../../constants/errorCodes");

      (require("../../controllers/admin/organizationController") as any)
        .deleteOrganization = (_req: any, _res: any, next: any) => {
          throw createError(ERROR_CODES.NOT_FOUND, "Organization not found", {
            message: "Organization not found",
          });
        };

      const response = await request(app)
        .delete("/api/admin/organizations/non-existent")
        .expect(404);

      expect(response.body.error).toBe("Not Found");
    });
  });
});