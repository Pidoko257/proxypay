import { Pool } from "pg";

jest.mock("axios", () => {
  const mockCreate = jest.fn().mockReturnValue({
    post: jest.fn(),
    get: jest.fn(),
    interceptors: {
      request: { use: jest.fn() },
      response: { use: jest.fn() },
    },
  });
  return { default: { create: mockCreate }, create: mockCreate };
});

jest.mock("../../utils/logger", () => {
  const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: log };
});

process.env.KYC_API_KEY = "test_key";
process.env.NODE_ENV = "test";

import { KYCService } from "../../services/kyc";
import logger from "../../utils/logger";

describe("KYCService — PII-safe logging", () => {
  let service: KYCService;
  let mockDb: jest.Mocked<Pool>;
  let mockApi: any;
  let consoleLog: jest.SpyInstance;
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleLog = jest.spyOn(console, "log").mockImplementation(() => undefined);
    consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    mockDb = { query: jest.fn() } as unknown as jest.Mocked<Pool>;
    service = new KYCService(mockDb);
    const axios = require("axios");
    mockApi = axios.create.mock.results[axios.create.mock.results.length - 1].value;
  });

  afterEach(() => {
    consoleLog.mockRestore();
    consoleError.mockRestore();
  });

  const allLogged = () =>
    JSON.stringify([
      (logger.debug as jest.Mock).mock.calls,
      (logger.info as jest.Mock).mock.calls,
      (logger.warn as jest.Mock).mock.calls,
      (logger.error as jest.Mock).mock.calls,
      consoleLog.mock.calls,
      consoleError.mock.calls,
    ]);

  it("logs requests at debug level with url and method only", () => {
    const [onRequest] = mockApi.interceptors.request.use.mock.calls[0];
    onRequest({ url: "/applicants", method: "post", data: { first_name: "Alice" } });

    expect(logger.debug).toHaveBeenCalledWith(
      { url: "/applicants", method: "post" },
      "KYC API request",
    );
    expect(allLogged()).not.toContain("Alice");
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it("never logs the provider error response body", async () => {
    const [, onError] = mockApi.interceptors.response.use.mock.calls[0];
    const error = {
      config: { url: "/applicants", method: "post" },
      response: {
        status: 422,
        data: { first_name: "Alice", last_name: "Nkomo", dob: "1990-05-15" },
      },
    };

    await expect(onError(error)).rejects.toBe(error);

    expect(logger.warn).toHaveBeenCalled();
    const logged = allLogged();
    expect(logged).not.toContain("Alice");
    expect(logged).not.toContain("Nkomo");
    expect(logged).not.toContain("1990-05-15");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("does not log applicant name or DOB on deduplication", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ applicant_id: "existing-id", first_name: "Alice", last_name: "Nkomo", dob: "1990-05-15", created_at: "2026-01-01T00:00:00Z" }],
      rowCount: 1,
    } as any);

    await service.createApplicant({ first_name: "Alice", last_name: "Nkomo", dob: "1990-05-15" });

    expect(logger.info).toHaveBeenCalledWith(
      { applicantId: "existing-id" },
      expect.any(String),
    );
    const logged = allLogged();
    expect(logged).not.toContain("Alice");
    expect(logged).not.toContain("Nkomo");
    expect(logged).not.toContain("1990-05-15");
  });
});
