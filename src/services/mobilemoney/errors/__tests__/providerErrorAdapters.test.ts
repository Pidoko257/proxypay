/**
 * Unit tests for provider-specific error adapters — Issue #164
 */

import { MTNErrorAdapter } from "../mtnErrorAdapter";
import { AirtelErrorAdapter } from "../airtelErrorAdapter";
import { OrangeErrorAdapter } from "../orangeErrorAdapter";
import { ProviderErrorCode } from "../providerErrors";
import { getProviderErrorAdapter } from "../index";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAxiosError(
  status: number,
  body: Record<string, unknown>,
  message = "Request failed",
) {
  const err: any = new Error(message);
  err.isAxiosError = true;
  err.response = { status, data: body };
  return err;
}

// ─── MTN Adapter ──────────────────────────────────────────────────────────────

describe("MTNErrorAdapter", () => {
  const adapter = new MTNErrorAdapter();

  it("identifies provider name", () => {
    expect(adapter.providerName).toBe("mtn");
  });

  it("maps PAYEE_NOT_FOUND to RECIPIENT_NOT_FOUND", () => {
    const raw = makeAxiosError(404, {
      code: "PAYEE_NOT_FOUND",
      message: "Payee not found",
    });
    const err = adapter.mapError(raw, "requestPayment");
    expect(err.code).toBe(ProviderErrorCode.RECIPIENT_NOT_FOUND);
    expect(err.provider).toBe("mtn");
    expect(err.operation).toBe("requestPayment");
    expect(err.httpStatus).toBe(404);
    expect(err.rawCode).toBe("PAYEE_NOT_FOUND");
    expect(err.isTransient).toBe(false);
  });

  it("maps RESOURCE_ALREADY_EXIST to DUPLICATE_TRANSACTION", () => {
    const raw = makeAxiosError(409, {
      code: "RESOURCE_ALREADY_EXIST",
      message: "Already exists",
    });
    const err = adapter.mapError(raw, "requestPayment");
    expect(err.code).toBe(ProviderErrorCode.DUPLICATE_TRANSACTION);
    expect(err.isTransient).toBe(false);
  });

  it("maps HTTP 503 to SERVICE_UNAVAILABLE (transient)", () => {
    const raw = makeAxiosError(503, { message: "Service temporarily unavailable" });
    const err = adapter.mapError(raw, "requestPayment");
    expect(err.code).toBe(ProviderErrorCode.SERVICE_UNAVAILABLE);
    expect(err.isTransient).toBe(true);
  });

  it("maps HTTP 429 to RATE_LIMITED (transient)", () => {
    const raw = makeAxiosError(429, { message: "Too many requests" });
    const err = adapter.mapError(raw, "sendPayout");
    expect(err.code).toBe(ProviderErrorCode.RATE_LIMITED);
    expect(err.isTransient).toBe(true);
  });

  it("maps LIMIT_REACHED to ACCOUNT_LIMIT_EXCEEDED", () => {
    const raw = makeAxiosError(400, {
      code: "LIMIT_REACHED",
      message: "Transaction limit reached",
    });
    const err = adapter.mapError(raw, "requestPayment");
    expect(err.code).toBe(ProviderErrorCode.ACCOUNT_LIMIT_EXCEEDED);
  });

  it("maps network timeout error to TIMEOUT (transient)", () => {
    const networkErr: any = new Error("read ETIMEDOUT");
    networkErr.code = "ETIMEDOUT";
    const err = adapter.mapError(networkErr, "requestPayment");
    expect(err.code).toBe(ProviderErrorCode.TIMEOUT);
    expect(err.isTransient).toBe(true);
  });

  it("maps ECONNREFUSED to NETWORK_ERROR (transient)", () => {
    const networkErr: any = new Error("connect ECONNREFUSED");
    networkErr.code = "ECONNREFUSED";
    const err = adapter.mapError(networkErr, "getBalance");
    expect(err.code).toBe(ProviderErrorCode.NETWORK_ERROR);
    expect(err.isTransient).toBe(true);
  });

  it("maps unknown string error to UNKNOWN", () => {
    const err = adapter.mapError("some random string", "requestPayment");
    expect(err.code).toBe(ProviderErrorCode.UNKNOWN);
  });

  it("includes originalError in the mapped error", () => {
    const raw = makeAxiosError(500, { message: "Internal error" });
    const err = adapter.mapError(raw, "sendPayout");
    expect(err.originalError).toBe(raw);
  });

  it("serialises to JSON cleanly", () => {
    const raw = makeAxiosError(401, { code: "unauthorized", message: "Unauthorized" });
    const err = adapter.mapError(raw, "getAccessToken");
    const json = err.toJSON();
    expect(json.provider).toBe("mtn");
    expect(json.code).toBe(ProviderErrorCode.AUTHENTICATION_FAILED);
    expect(typeof json.timestamp).toBe("string");
  });
});

// ─── Airtel Adapter ───────────────────────────────────────────────────────────

describe("AirtelErrorAdapter", () => {
  const adapter = new AirtelErrorAdapter();

  it("identifies provider name", () => {
    expect(adapter.providerName).toBe("airtel");
  });

  it("maps Airtel app-level error (HTTP 200, success:false) to RECIPIENT_NOT_FOUND", () => {
    const appError = {
      status: { success: false, code: "ESB000014", message: "Payee does not exist" },
    };
    const err = adapter.mapError(appError, "requestPayment");
    expect(err.code).toBe(ProviderErrorCode.RECIPIENT_NOT_FOUND);
    expect(err.rawCode).toBe("ESB000014");
    expect(err.isTransient).toBe(false);
  });

  it("maps Airtel insufficient funds code to INSUFFICIENT_FUNDS", () => {
    const appError = {
      status: { success: false, code: "DP00800001000", message: "Insufficient funds" },
    };
    const err = adapter.mapError(appError, "requestPayment");
    expect(err.code).toBe(ProviderErrorCode.INSUFFICIENT_FUNDS);
  });

  it("maps Airtel duplicate transaction code to DUPLICATE_TRANSACTION", () => {
    const appError = {
      status: { success: false, code: "ESB000033", message: "Duplicate reference" },
    };
    const err = adapter.mapError(appError, "requestPayment");
    expect(err.code).toBe(ProviderErrorCode.DUPLICATE_TRANSACTION);
    expect(err.isTransient).toBe(false);
  });

  it("maps HTTP 503 to SERVICE_UNAVAILABLE (transient)", () => {
    const raw = makeAxiosError(503, { message: "Maintenance" });
    const err = adapter.mapError(raw, "requestPayment");
    expect(err.code).toBe(ProviderErrorCode.SERVICE_UNAVAILABLE);
    expect(err.isTransient).toBe(true);
  });

  it("maps HTTP 429 to RATE_LIMITED (transient)", () => {
    const raw = makeAxiosError(429, {});
    const err = adapter.mapError(raw, "sendPayout");
    expect(err.code).toBe(ProviderErrorCode.RATE_LIMITED);
    expect(err.isTransient).toBe(true);
  });

  it("maps network error to NETWORK_ERROR (transient)", () => {
    const networkErr: any = new Error("connect ECONNRESET");
    networkErr.code = "ECONNRESET";
    const err = adapter.mapError(networkErr, "requestPayment");
    expect(err.code).toBe(ProviderErrorCode.NETWORK_ERROR);
    expect(err.isTransient).toBe(true);
  });
});

// ─── Orange Adapter ───────────────────────────────────────────────────────────

describe("OrangeErrorAdapter", () => {
  const adapter = new OrangeErrorAdapter();

  it("identifies provider name", () => {
    expect(adapter.providerName).toBe("orange");
  });

  it("maps INSUFFICIENT_BALANCE to INSUFFICIENT_FUNDS", () => {
    const raw = makeAxiosError(400, {
      code: "INSUFFICIENT_BALANCE",
      message: "Balance too low",
    });
    const err = adapter.mapError(raw, "requestPayment");
    expect(err.code).toBe(ProviderErrorCode.INSUFFICIENT_FUNDS);
    expect(err.isTransient).toBe(false);
  });

  it("maps ACCOUNT_BLOCKED to RECIPIENT_ACCOUNT_BLOCKED", () => {
    const raw = makeAxiosError(403, {
      code: "ACCOUNT_BLOCKED",
      message: "Account is blocked",
    });
    const err = adapter.mapError(raw, "requestPayment");
    expect(err.code).toBe(ProviderErrorCode.RECIPIENT_ACCOUNT_BLOCKED);
  });

  it("maps DAILY_LIMIT_EXCEEDED to ACCOUNT_LIMIT_EXCEEDED", () => {
    const raw = makeAxiosError(400, {
      code: "DAILY_LIMIT_EXCEEDED",
      message: "Daily limit reached",
    });
    const err = adapter.mapError(raw, "requestPayment");
    expect(err.code).toBe(ProviderErrorCode.ACCOUNT_LIMIT_EXCEEDED);
  });

  it("maps HTTP 500 to SERVICE_UNAVAILABLE (transient)", () => {
    const raw = makeAxiosError(500, { message: "Internal error" });
    const err = adapter.mapError(raw, "requestPayment");
    expect(err.code).toBe(ProviderErrorCode.SERVICE_UNAVAILABLE);
    expect(err.isTransient).toBe(true);
  });

  it("maps plain object error with code field", () => {
    const err = adapter.mapError(
      { code: "AUTH_FAILED", message: "Auth failed" },
      "login",
    );
    expect(err.code).toBe(ProviderErrorCode.AUTHENTICATION_FAILED);
  });

  it("maps timeout error to TIMEOUT (transient)", () => {
    const networkErr: any = new Error("timeout of 5000ms exceeded");
    const err = adapter.mapError(networkErr, "requestPayment");
    expect(err.code).toBe(ProviderErrorCode.TIMEOUT);
    expect(err.isTransient).toBe(true);
  });
});

// ─── Registry ────────────────────────────────────────────────────────────────

describe("getProviderErrorAdapter", () => {
  it("returns MTNErrorAdapter for 'mtn'", () => {
    const adapter = getProviderErrorAdapter("mtn");
    expect(adapter.providerName).toBe("mtn");
  });

  it("returns AirtelErrorAdapter for 'airtel'", () => {
    const adapter = getProviderErrorAdapter("airtel");
    expect(adapter.providerName).toBe("airtel");
  });

  it("returns OrangeErrorAdapter for 'orange'", () => {
    const adapter = getProviderErrorAdapter("orange");
    expect(adapter.providerName).toBe("orange");
  });

  it("is case-insensitive for provider lookup", () => {
    const adapter = getProviderErrorAdapter("MTN");
    expect(adapter.providerName).toBe("mtn");
  });

  it("returns a generic adapter for unknown providers", () => {
    const adapter = getProviderErrorAdapter("vodacom");
    expect(adapter).toBeDefined();
    const err = adapter.mapError(new Error("test"), "pay");
    expect(err.code).toBe(ProviderErrorCode.UNKNOWN);
  });
});

// ─── ProviderError properties ─────────────────────────────────────────────────

describe("ProviderError", () => {
  it("isTransient is true for SERVICE_UNAVAILABLE", () => {
    const adapter = new MTNErrorAdapter();
    const raw = makeAxiosError(503, {});
    const err = adapter.mapError(raw, "test");
    expect(err.isTransient).toBe(true);
  });

  it("isTransient is false for INVALID_REQUEST", () => {
    const adapter = new MTNErrorAdapter();
    const raw = makeAxiosError(400, { code: "INVALID_AMOUNT" });
    const err = adapter.mapError(raw, "test");
    expect(err.isTransient).toBe(false);
  });

  it("has a timestamp", () => {
    const adapter = new MTNErrorAdapter();
    const raw = makeAxiosError(400, {});
    const err = adapter.mapError(raw, "test");
    expect(err.timestamp).toBeInstanceOf(Date);
  });
});
