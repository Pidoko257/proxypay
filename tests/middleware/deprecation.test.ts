import {
  markEndpointDeprecated,
  isEndpointDeprecated,
  getDeprecatedEndpoints,
  deprecationHeadersMiddleware,
  registerDeprecatedEndpoints,
  getDeprecationTimeline,
  generateDeprecationReport,
  DEPRECATED_ENDPOINTS,
} from "../../src/middleware/deprecation";
import {
  addDeprecationToOpenAPISpec,
  createDeprecationHeaders,
  generateDeprecationDocumentation,
} from "../../src/openapi/deprecationHandler";
import { Request, Response } from "express";

describe("API Deprecation System", () => {
  beforeEach(() => {
    // Clear deprecated endpoints before each test
    const endpoints = getDeprecatedEndpoints();
    endpoints.forEach((ep) => {
      // We can't directly clear the map, so we'll test with fresh ones
    });
  });

  describe("markEndpointDeprecated and isEndpointDeprecated", () => {
    it("should mark and retrieve deprecated endpoints", () => {
      const metadata = {
        deprecated: true as const,
        sunsetDate: new Date("2027-01-01"),
        alternativeEndpoint: "POST /api/v2/transactions",
        reason: "Use v2 API",
      };

      markEndpointDeprecated("POST", "/api/v1/transactions", metadata);

      const retrieved = isEndpointDeprecated("POST", "/api/v1/transactions");
      expect(retrieved).toEqual(metadata);
    });

    it("should return undefined for non-deprecated endpoints", () => {
      const retrieved = isEndpointDeprecated("GET", "/api/v2/unknown");
      expect(retrieved).toBeUndefined();
    });

    it("should differentiate between HTTP methods", () => {
      const metadata = {
        deprecated: true as const,
        sunsetDate: new Date("2027-01-01"),
      };

      markEndpointDeprecated("GET", "/api/v1/transactions", metadata);

      const get = isEndpointDeprecated("GET", "/api/v1/transactions");
      const post = isEndpointDeprecated("POST", "/api/v1/transactions");

      expect(get).toBeDefined();
      expect(post).toBeUndefined();
    });
  });

  describe("getDeprecatedEndpoints", () => {
    it("should return all deprecated endpoints", () => {
      const meta1 = {
        deprecated: true as const,
        sunsetDate: new Date("2027-01-01"),
      };
      const meta2 = {
        deprecated: true as const,
        sunsetDate: new Date("2027-02-01"),
      };

      markEndpointDeprecated("GET", "/api/v1/foo", meta1);
      markEndpointDeprecated("POST", "/api/v1/bar", meta2);

      const endpoints = getDeprecatedEndpoints();
      expect(endpoints.length).toBeGreaterThanOrEqual(2);
      expect(endpoints.some((e) => e.path === "/api/v1/foo")).toBe(true);
      expect(endpoints.some((e) => e.path === "/api/v1/bar")).toBe(true);
    });
  });

  describe("deprecationHeadersMiddleware", () => {
    it("should add deprecation headers to deprecated endpoints", () => {
      const metadata = {
        deprecated: true as const,
        sunsetDate: new Date("2027-06-01"),
        alternativeEndpoint: "POST /api/v2/transactions",
        migrationGuide: "https://docs.example.com/migration",
        reason: "Use improved v2 API",
      };

      markEndpointDeprecated("POST", "/api/v1/transactions", metadata);

      const req = { method: "POST", path: "/api/v1/transactions", ip: "127.0.0.1", get: () => "Mozilla/5.0" } as unknown as Request;
      const res = {
        set: jest.fn().mockReturnThis(),
      } as unknown as Response;
      const next = jest.fn();

      deprecationHeadersMiddleware(req, res, next);

      expect(res.set).toHaveBeenCalledWith("Deprecation", "true");
      expect(res.set).toHaveBeenCalledWith("Sunset", expect.any(String));
      expect(res.set).toHaveBeenCalledWith(
        "X-API-Alternative-Endpoint",
        "POST /api/v2/transactions",
      );
      expect(res.set).toHaveBeenCalledWith(
        "X-API-Migration-Guide",
        "https://docs.example.com/migration",
      );
      expect(res.set).toHaveBeenCalledWith(
        "X-API-Deprecation-Reason",
        "Use improved v2 API",
      );
      expect(next).toHaveBeenCalled();
    });

    it("should not add headers for non-deprecated endpoints", () => {
      const req = {
        method: "GET",
        path: "/api/v2/transactions",
        ip: "127.0.0.1",
        get: () => "Mozilla/5.0",
      } as unknown as Request;
      const res = {
        set: jest.fn().mockReturnThis(),
      } as unknown as Response;
      const next = jest.fn();

      deprecationHeadersMiddleware(req, res, next);

      expect(res.set).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });
  });

  describe("registerDeprecatedEndpoints", () => {
    it("should register all deprecated endpoints", () => {
      registerDeprecatedEndpoints();

      const endpoints = getDeprecatedEndpoints();
      expect(endpoints.length).toBe(Object.keys(DEPRECATED_ENDPOINTS).length);
    });

    it("should register endpoints with correct metadata", () => {
      registerDeprecatedEndpoints();

      const txDeprecated = isEndpointDeprecated("GET", "/api/v1/transactions");
      expect(txDeprecated).toBeDefined();
      expect(txDeprecated?.alternativeEndpoint).toBe("GET /api/v2/transactions");
      expect(txDeprecated?.reason).toContain("v2 API");
    });
  });

  describe("getDeprecationTimeline", () => {
    it("should group endpoints by sunset date", () => {
      registerDeprecatedEndpoints();

      const timeline = getDeprecationTimeline();
      expect(timeline.length).toBeGreaterThan(0);

      // Each timeline item should have endpoints scheduled for that date
      for (const item of timeline) {
        expect(item.date).toBeInstanceOf(Date);
        expect(item.daysSinceNow).toBeDefined();
        expect(item.endpointCount).toBeGreaterThan(0);
        expect(item.endpoints.length).toEqual(item.endpointCount);
      }
    });

    it("should sort timeline chronologically", () => {
      registerDeprecatedEndpoints();

      const timeline = getDeprecationTimeline();
      for (let i = 0; i < timeline.length - 1; i++) {
        expect(timeline[i].date.getTime()).toBeLessThanOrEqual(
          timeline[i + 1].date.getTime(),
        );
      }
    });
  });

  describe("generateDeprecationReport", () => {
    it("should generate a markdown deprecation report", () => {
      registerDeprecatedEndpoints();

      const report = generateDeprecationReport();

      expect(report).toContain("# API Deprecation Report");
      expect(report).toContain("Deprecation Timeline");
      expect(report).toContain("Deprecated Endpoints");
      expect(report).toMatch(/\d{4}-\d{2}-\d{2}/); // Date format
    });

    it("should include sunset dates in the report", () => {
      registerDeprecatedEndpoints();

      const report = generateDeprecationReport();
      const deprecatedEndpoints = getDeprecatedEndpoints();

      for (const item of deprecatedEndpoints.slice(0, 2)) {
        const sunsetDate = item.metadata.sunsetDate.toISOString().split("T")[0];
        expect(report).toContain(sunsetDate);
      }
    });
  });

  describe("createDeprecationHeaders", () => {
    it("should create deprecation response headers", () => {
      registerDeprecatedEndpoints();

      const headers = createDeprecationHeaders("GET", "/api/v1/transactions");

      expect(headers.Deprecation).toBe("true");
      expect(headers.Sunset).toBeDefined();
      expect(headers["X-API-Alternative-Endpoint"]).toBe("GET /api/v2/transactions");
    });

    it("should return empty object for non-deprecated endpoints", () => {
      registerDeprecatedEndpoints();

      const headers = createDeprecationHeaders("GET", "/api/v2/unknown");

      expect(Object.keys(headers).length).toBe(0);
    });
  });

  describe("addDeprecationToOpenAPISpec", () => {
    it("should mark deprecated endpoints in OpenAPI spec", () => {
      registerDeprecatedEndpoints();

      const spec = {
        openapi: "3.0.0",
        info: { title: "API", version: "1.0.0" },
        paths: {
          "/api/v1/transactions": {
            get: {
              summary: "List transactions",
              description: "Get all transactions",
            },
          },
          "/api/v2/transactions": {
            get: {
              summary: "List transactions v2",
            },
          },
        },
      };

      addDeprecationToOpenAPISpec(spec);

      expect(spec.paths["/api/v1/transactions"].get.deprecated).toBe(true);
      expect(spec.paths["/api/v1/transactions"].get.description).toContain(
        "DEPRECATED",
      );
      expect(spec.paths["/api/v1/transactions"].get["x-sunset-date"]).toBeDefined();
      expect(spec.info.description).toContain("Deprecation Notice");
    });
  });

  describe("generateDeprecationDocumentation", () => {
    it("should generate comprehensive deprecation documentation", () => {
      registerDeprecatedEndpoints();

      const doc = generateDeprecationDocumentation();

      expect(doc).toContain("# API Deprecation Policy");
      expect(doc).toContain("Deprecation Timeline");
      expect(doc).toContain("Active Deprecations");
      expect(doc).toContain("Response Headers");
      expect(doc).toContain("Migration Steps");
      expect(doc).toContain("Deprecation: true");
      expect(doc).toContain("Sunset:");
    });

    it("should include migration guides", () => {
      registerDeprecatedEndpoints();

      const doc = generateDeprecationDocumentation();

      // Should reference migration guides from deprecated endpoints
      expect(doc).toContain("Migration Guide");
    });
  });

  describe("Deprecation scenarios", () => {
    it("should handle multiple deprecations on same path with different methods", () => {
      const meta = {
        deprecated: true as const,
        sunsetDate: new Date("2027-01-01"),
      };

      markEndpointDeprecated("GET", "/api/v1/foo", meta);
      markEndpointDeprecated("POST", "/api/v1/foo", meta);
      markEndpointDeprecated("DELETE", "/api/v1/foo", meta);

      expect(isEndpointDeprecated("GET", "/api/v1/foo")).toBeDefined();
      expect(isEndpointDeprecated("POST", "/api/v1/foo")).toBeDefined();
      expect(isEndpointDeprecated("DELETE", "/api/v1/foo")).toBeDefined();

      const endpoints = getDeprecatedEndpoints();
      const fooEndpoints = endpoints.filter((e) => e.path === "/api/v1/foo");
      expect(fooEndpoints.length).toBeGreaterThanOrEqual(3);
    });

    it("should include all deprecated endpoint info in timeline", () => {
      registerDeprecatedEndpoints();

      const timeline = getDeprecationTimeline();
      const totalEndpoints = timeline.reduce((sum, item) => sum + item.endpointCount, 0);
      const totalDeprecated = getDeprecatedEndpoints().length;

      expect(totalEndpoints).toBe(totalDeprecated);
    });

    it("should calculate days until sunset correctly", () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 30); // 30 days from now

      const meta = {
        deprecated: true as const,
        sunsetDate: futureDate,
      };

      markEndpointDeprecated("GET", "/api/v1/test", meta);

      const timeline = getDeprecationTimeline();
      const item = timeline.find((t) => t.endpointCount > 0);

      if (item) {
        expect(item.daysSinceNow).toBeGreaterThanOrEqual(29);
        expect(item.daysSinceNow).toBeLessThanOrEqual(31);
      }
    });
  });
});
