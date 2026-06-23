import request from "supertest";
import app from "../src/index";
import { pool } from "../src/config/database";
import { disconnectRedis } from "../src/config/redis";

describe("GET /health/db", () => {
  afterAll(async () => {
    await pool.end();
    await disconnectRedis();
  });

  it("should return database pool statistics", async () => {
    const response = await request(app).get("/health/db");
    
    // The database might be offline in clean test environment, or it might be online.
    // So we handle both 200 and 503 statuses.
    expect([200, 503]).toContain(response.status);
    
    if (response.status === 200) {
      expect(response.body).toHaveProperty("status", "ok");
    } else {
      expect(response.body).toHaveProperty("status", "error");
      expect(response.body).toHaveProperty("message", "Database connection failed");
      expect(response.body).toHaveProperty("error");
    }

    expect(response.body).toHaveProperty("activeConnections");
    expect(response.body).toHaveProperty("idleConnections");
    expect(response.body).toHaveProperty("waitingQueries");
    expect(response.body).toHaveProperty("timestamp");
    
    expect(typeof response.body.activeConnections).toBe("number");
    expect(typeof response.body.idleConnections).toBe("number");
    expect(typeof response.body.waitingQueries).toBe("number");
  });

  it("should fail health check and return 503 when pool query fails", async () => {
    // Mock pool.query to reject
    const originalQuery = pool.query;
    pool.query = jest.fn().mockRejectedValue(new Error("Connection timeout"));

    try {
      const response = await request(app).get("/health/db");
      expect(response.status).toBe(503);
      expect(response.body).toHaveProperty("status", "error");
      expect(response.body).toHaveProperty("message", "Database connection failed");
      expect(response.body.error).toBe("Connection timeout");
      expect(response.body).toHaveProperty("activeConnections");
      expect(response.body).toHaveProperty("idleConnections");
      expect(response.body).toHaveProperty("waitingQueries");
    } finally {
      // Restore
      pool.query = originalQuery;
    }
  });
});
