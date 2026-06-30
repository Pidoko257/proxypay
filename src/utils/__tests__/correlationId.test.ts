import {
  generateCorrelationId,
  getOrGenerateCorrelationId,
  isValidCorrelationId,
  createContext,
} from "../correlationId";

describe("correlationId utility", () => {
  describe("generateCorrelationId", () => {
    it("should generate a valid correlation ID", () => {
      const id = generateCorrelationId();
      expect(id).toMatch(/^corr-/);
      expect(id.length).toBeGreaterThan(15);
    });

    it("should generate unique IDs", () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) {
        ids.add(generateCorrelationId());
      }
      expect(ids.size).toBe(100);
    });
  });

  describe("isValidCorrelationId", () => {
    it("should validate correct format", () => {
      expect(isValidCorrelationId("corr-abc123-def456-ghi789")).toBe(true);
      expect(isValidCorrelationId("corr-1a2b3c4d-5e6f-7g8h")).toBe(true);
    });

    it("should reject invalid formats", () => {
      expect(isValidCorrelationId("invalid")).toBe(false);
      expect(isValidCorrelationId("")).toBe(false);
      expect(isValidCorrelationId("corr-")).toBe(false);
    });
  });

  describe("getOrGenerateCorrelationId", () => {
    it("should return existing valid correlation ID from headers", () => {
      const headers = { "x-correlation-id": "corr-test123-abc456-def789" };
      const result = getOrGenerateCorrelationId(headers);
      expect(result).toBe("corr-test123-abc456-def789");
    });

    it("should generate new ID when header is missing", () => {
      const headers = {};
      const result = getOrGenerateCorrelationId(headers);
      expect(isValidCorrelationId(result)).toBe(true);
    });

    it("should generate new ID when header is invalid", () => {
      const headers = { "x-correlation-id": "invalid-id" };
      const result = getOrGenerateCorrelationId(headers);
      expect(isValidCorrelationId(result)).toBe(true);
    });
  });

  describe("createContext", () => {
    it("should create context with correlation ID and timestamp", () => {
      const headers = {};
      const context = createContext(headers);
      expect(context.correlationId).toBeDefined();
      expect(context.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});