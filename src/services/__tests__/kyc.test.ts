import { Pool } from "pg";

jest.mock("../accounting", () => ({ AccountingService: jest.fn() }));

import KYCService from "../kyc";

describe("KYCService configuration", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousApiKey = process.env.KYC_API_KEY;

  afterEach(() => {
    process.env.NODE_ENV = previousNodeEnv;
    if (previousApiKey === undefined) {
      delete process.env.KYC_API_KEY;
    } else {
      process.env.KYC_API_KEY = previousApiKey;
    }
  });

  it("defers the missing API key error until a provider method is called", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.KYC_API_KEY;

    const service = new KYCService({ query: jest.fn() } as unknown as Pool);

    await expect(service.getApplicant("applicant-1")).rejects.toThrow(
      "KYC_API_KEY environment variable is required",
    );
  });
});
