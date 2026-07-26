/**
 * Tests for POST /api/merchant/webhooks/:id/re-enable
 *
 * Auth middleware is bypassed by injecting req.jwtUser directly via a
 * test middleware, matching the pattern used across other route tests in
 * this repo.
 */

import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

// ─── Shared mock functions — defined before any jest.mock() calls ─────────────

const mockFindById = jest.fn();
const mockReEnable = jest.fn();

// ─── Mocks ─────────────────────────────────────────────────────────────────

// Use factory form so the route module picks up these implementations
// even though `new MerchantWebhookModel()` is called at module-load time.
jest.mock("../../src/models/merchantWebhook", () => ({
  MerchantWebhookModel: jest.fn().mockImplementation(() => ({
    findById: mockFindById,
    reEnable: mockReEnable,
    findByUserId: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    insertDeliveryLog: jest.fn(),
    getDeliveryLogs: jest.fn(),
    findActiveWithSufficientHistory: jest.fn(),
    getSuccessRate: jest.fn(),
    disableBySystem: jest.fn(),
  })),
}));

jest.mock("../../src/services/merchantWebhookService", () => ({
  MerchantWebhookService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("../../src/middleware/auth", () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// Import routes AFTER mocks are registered
import merchantWebhookRoutes from "../../src/routes/merchantWebhooks";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const USER_ID = "user_test_123";
const WEBHOOK_ID = "wh_test_abc";

function buildApp(userId = USER_ID) {
  const app = express();
  app.use(express.json());
  // Inject authenticated user before routes
  app.use((req: any, _res: Response, next: NextFunction) => {
    req.jwtUser = { userId };
    next();
  });
  app.use("/api/merchant/webhooks", merchantWebhookRoutes);
  return app;
}

function makeWebhook(overrides: Record<string, unknown> = {}) {
  return {
    id: WEBHOOK_ID,
    userId: USER_ID,
    url: "https://example.com/webhook",
    secret: "test-secret-key",
    events: ["transaction.completed"],
    isActive: false,
    disabledReason:
      "Automatically disabled: success rate 10.0% over last 100 deliveries is below the 30% threshold.",
    disabledAt: new Date("2026-07-26T09:00:00.000Z"),
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-07-26T09:00:00.000Z"),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/merchant/webhooks/:id/re-enable", () => {
  beforeEach(() => {
    mockFindById.mockReset();
    mockReEnable.mockReset();
  });

  it("re-enables a disabled webhook and returns the updated object", async () => {
    const disabled = makeWebhook({ isActive: false });
    const reEnabled = makeWebhook({
      isActive: true,
      disabledReason: undefined,
      disabledAt: undefined,
    });

    mockFindById.mockResolvedValue(disabled);
    mockReEnable.mockResolvedValue(reEnabled);

    const res = await request(buildApp())
      .post(`/api/merchant/webhooks/${WEBHOOK_ID}/re-enable`)
      .expect(200);

    expect(res.body.re_enabled).toBe(true);
    expect(res.body.webhook.id).toBe(WEBHOOK_ID);
    expect(res.body.webhook.isActive).toBe(true);
    // secret must never be returned
    expect(res.body.webhook.secret).toBeUndefined();

    expect(mockFindById).toHaveBeenCalledWith(WEBHOOK_ID, USER_ID);
    expect(mockReEnable).toHaveBeenCalledWith(WEBHOOK_ID, USER_ID);
  });

  it("returns 401 when not authenticated", async () => {
    // Build app without injecting jwtUser
    const app = express();
    app.use(express.json());
    app.use("/api/merchant/webhooks", merchantWebhookRoutes);

    const res = await request(app)
      .post(`/api/merchant/webhooks/${WEBHOOK_ID}/re-enable`)
      .expect(401);

    expect(res.body.error).toBe("Unauthorized");
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it("returns 404 when webhook does not exist or belong to user", async () => {
    mockFindById.mockResolvedValue(null);

    const res = await request(buildApp())
      .post(`/api/merchant/webhooks/non-existent/re-enable`)
      .expect(404);

    expect(res.body.error).toBe("Webhook not found");
    expect(mockReEnable).not.toHaveBeenCalled();
  });

  it("returns 409 when webhook is already active", async () => {
    const active = makeWebhook({ isActive: true, disabledReason: undefined });
    mockFindById.mockResolvedValue(active);

    const res = await request(buildApp())
      .post(`/api/merchant/webhooks/${WEBHOOK_ID}/re-enable`)
      .expect(409);

    expect(res.body.error).toBe("Webhook is already active");
    expect(res.body.webhook_id).toBe(WEBHOOK_ID);
    expect(mockReEnable).not.toHaveBeenCalled();
  });

  it("returns 404 when reEnable returns null (race condition)", async () => {
    const disabled = makeWebhook({ isActive: false });
    mockFindById.mockResolvedValue(disabled);
    mockReEnable.mockResolvedValue(null); // concurrent deletion

    const res = await request(buildApp())
      .post(`/api/merchant/webhooks/${WEBHOOK_ID}/re-enable`)
      .expect(404);

    expect(res.body.error).toBe("Webhook not found");
  });

  it("returns 500 on unexpected database error", async () => {
    mockFindById.mockRejectedValue(new Error("DB connection lost"));

    const res = await request(buildApp())
      .post(`/api/merchant/webhooks/${WEBHOOK_ID}/re-enable`)
      .expect(500);

    expect(res.body.error).toBe("Internal server error");
  });

  it("does not allow re-enabling another user's webhook", async () => {
    // findById is scoped to userId — returns null for a different user
    mockFindById.mockResolvedValue(null);

    const res = await request(buildApp("different_user_id"))
      .post(`/api/merchant/webhooks/${WEBHOOK_ID}/re-enable`)
      .expect(404);

    expect(res.body.error).toBe("Webhook not found");
    expect(mockReEnable).not.toHaveBeenCalled();
  });
});
