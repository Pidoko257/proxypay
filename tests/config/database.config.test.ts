import { pool } from "../../src/config/database";

describe("Database connection pool configuration", () => {
  it("should have pool options configured with numbers", () => {
    expect(pool.options).toBeDefined();
    expect(typeof pool.options.min).toBe("number");
    expect(typeof pool.options.max).toBe("number");
    expect(typeof pool.options.idleTimeoutMillis).toBe("number");
    expect(typeof pool.options.connectionTimeoutMillis).toBe("number");
  });

  it("should enforce reasonable defaults", () => {
    // NODE_ENV is test during jest runs.
    // So the defaults should align with dev/test environment values: min=2, max=10, idleTimeoutMillis=30000, connectionTimeoutMillis=2000
    expect(pool.options.min).toBe(2);
    expect(pool.options.max).toBe(10);
    expect(pool.options.idleTimeoutMillis).toBe(30000);
    expect(pool.options.connectionTimeoutMillis).toBe(2000);
  });
});
