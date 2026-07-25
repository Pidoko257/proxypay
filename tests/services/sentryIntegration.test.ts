import * as Sentry from "@sentry/node";
import {
  attachErrorContext,
  captureError,
  addTransactionBreadcrumb,
  addProviderAPIBreadcrumb,
  addDatabaseBreadcrumb,
  shouldSampleError,
  setErrorFingerprint,
  captureProviderError,
  captureComplianceError,
} from "../../src/services/sentryIntegration";
import { Transaction, TransactionStatus } from "../../src/models/transaction";

jest.mock("@sentry/node");

describe("Sentry Integration", () => {
  let mockScope: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockScope = {
      setUser: jest.fn(),
      setContext: jest.fn(),
      setLevel: jest.fn(),
      setFingerprint: jest.fn(),
    };

    (Sentry.getCurrentScope as jest.Mock).mockReturnValue(mockScope);
    (Sentry.addBreadcrumb as jest.Mock).mockReturnValue(undefined);
    (Sentry.captureException as jest.Mock).mockReturnValue("event-id");
  });

  describe("attachErrorContext", () => {
    it("attaches user context", () => {
      attachErrorContext({
        userId: "user-123",
        transactionId: "txn-456",
        provider: "mtn",
      });

      expect(mockScope.setUser).toHaveBeenCalledWith({ id: "user-123" });
      expect(mockScope.setContext).toHaveBeenCalledWith(
        "error_context",
        expect.objectContaining({
          transactionId: "txn-456",
          provider: "mtn",
        }),
      );
    });

    it("omits user if not provided", () => {
      attachErrorContext({
        transactionId: "txn-456",
      });

      expect(mockScope.setUser).not.toHaveBeenCalled();
      expect(mockScope.setContext).toHaveBeenCalledWith(
        "error_context",
        expect.objectContaining({
          transactionId: "txn-456",
        }),
      );
    });
  });

  describe("captureError", () => {
    it("captures Error instance", () => {
      const error = new Error("Test error");
      const context = { userId: "user-123", endpoint: "/api/test" };

      const eventId = captureError(error, context);

      expect(Sentry.captureException).toHaveBeenCalledWith(error);
      expect(mockScope.setLevel).toHaveBeenCalledWith("error");
      expect(eventId).toBe("event-id");
    });

    it("captures non-Error types", () => {
      const context = { userId: "user-123" };

      captureError("string error", context);

      expect(Sentry.captureException).toHaveBeenCalled();
      const capturedError = (Sentry.captureException as jest.Mock).mock.calls[0][0];
      expect(capturedError).toBeInstanceOf(Error);
      expect(capturedError.message).toBe("string error");
    });

    it("sets severity level", () => {
      const error = new Error("Test error");

      captureError(error, {}, "fatal");

      expect(mockScope.setLevel).toHaveBeenCalledWith("fatal");
    });
  });

  describe("Breadcrumbs", () => {
    it("adds transaction breadcrumb", () => {
      const transaction: Partial<Transaction> = {
        id: "txn-123",
        status: TransactionStatus.Completed,
        type: "deposit",
        amount: "1000",
        provider: "mtn",
      };

      addTransactionBreadcrumb(transaction, "completed");

      expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "transaction",
          message: expect.stringContaining("txn-123"),
          level: "info",
        }),
      );
    });

    it("adds provider API breadcrumb", () => {
      addProviderAPIBreadcrumb("mtn", "/payment/request", "POST", 200, 500);

      expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "provider_api",
          message: expect.stringContaining("mtn"),
          level: "info",
        }),
      );
    });

    it("marks failed provider API calls as warning", () => {
      addProviderAPIBreadcrumb("mtn", "/payment/request", "POST", 500, 1000);

      const call = (Sentry.addBreadcrumb as jest.Mock).mock.calls[0][0];
      expect(call.level).toBe("warning");
    });

    it("adds database breadcrumb", () => {
      addDatabaseBreadcrumb("SELECT * FROM users", 100);

      expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "database",
          level: "debug",
        }),
      );
    });

    it("marks failed database queries as warning", () => {
      const error = new Error("Query failed");
      addDatabaseBreadcrumb("SELECT * FROM users", 500, error);

      const call = (Sentry.addBreadcrumb as jest.Mock).mock.calls[0][0];
      expect(call.level).toBe("warning");
    });
  });

  describe("Error Sampling", () => {
    it("skips 404 errors", () => {
      expect(shouldSampleError(404)).toBe(false);
    });

    it("skips timeout errors", () => {
      expect(shouldSampleError(500, "timeout")).toBe(false);
      expect(shouldSampleError(undefined, "Request timeout")).toBe(false);
    });

    it("skips client error codes", () => {
      expect(shouldSampleError(400)).toBe(false);
      expect(shouldSampleError(401)).toBe(false);
      expect(shouldSampleError(403)).toBe(false);
    });

    it("captures 5xx errors", () => {
      expect(shouldSampleError(500)).toBe(true);
      expect(shouldSampleError(503)).toBe(true);
    });

    it("captures unknown errors", () => {
      expect(shouldSampleError(undefined, "Unknown error")).toBe(true);
    });
  });

  describe("Error Fingerprinting", () => {
    it("sets custom fingerprint", () => {
      const error = new Error("Test error");
      setErrorFingerprint(error, "mtn", "provider_error");

      expect(mockScope.setFingerprint).toHaveBeenCalledWith(
        expect.arrayContaining(["provider_error", "mtn"]),
      );
    });
  });

  describe("Specialized Error Capture", () => {
    it("captures provider errors", () => {
      const error = new Error("Provider API failed");
      captureProviderError("mtn", error, { endpoint: "/payment" });

      expect(mockScope.setLevel).toHaveBeenCalledWith("error");
      expect(mockScope.setContext).toHaveBeenCalledWith(
        "provider_error",
        expect.objectContaining({
          provider: "mtn",
        }),
      );
      expect(Sentry.captureException).toHaveBeenCalledWith(error);
    });

    it("captures compliance errors", () => {
      const error = new Error("Transaction flagged");
      captureComplianceError(error, "user-123", "Large transaction");

      expect(mockScope.setLevel).toHaveBeenCalledWith("warning");
      expect(mockScope.setContext).toHaveBeenCalledWith(
        "compliance_error",
        expect.objectContaining({
          userId: "user-123",
          reason: "Large transaction",
        }),
      );
    });
  });
});
