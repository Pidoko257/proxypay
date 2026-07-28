import {
  getStaticCapabilities,
  describeCapabilities,
  buildCapabilitiesReport,
} from "../capabilityProbe";
import { registerBuiltinAdapter, ProviderAdapter } from "../adapterSpec";

const sampleAdapter: ProviderAdapter = {
  name: "sample-provider",
  displayName: "Sample",
  getEndpoints() {
    return {
      sandbox: "https://sandbox.example.com",
      production: "https://api.example.com",
      healthUrl: "https://sandbox.example.com/health",
    };
  },
  getCapabilities() {
    return {
      supportsPayment: true,
      supportsPayout: true,
      supportsBatchPayout: false,
      supportsStatusQuery: true,
      supportsBalance: true,
      authMode: "direct",
      supportedCurrencies: ["XAF"],
      defaultCurrency: "XAF",
    };
  },
  getRequiredCredentialFields() {
    return ["apiKey", "apiSecret"] as const;
  },
  instantiate() {
    return {
      async requestPayment() {
        return { success: true };
      },
      async sendPayout() {
        return { success: true };
      },
    };
  },
};

describe("capabilityProbe", () => {
  beforeAll(() => {
    registerBuiltinAdapter(sampleAdapter);
  });

  it("returns the static manifest for a registered provider", () => {
    const caps = getStaticCapabilities("sample-provider");
    expect(caps).toBeTruthy();
    expect(caps?.authMode).toBe("direct");
    expect(caps?.supportsPayment).toBe(true);
  });

  it("returns null for an unknown provider", () => {
    expect(getStaticCapabilities("never-registered")).toBeNull();
  });

  it("describes capabilities in a one-line format", () => {
    const line = describeCapabilities("sample-provider");
    expect(line).toContain("sample-provider");
    expect(line).toContain("[direct]");
    expect(line).toContain("payment");
    expect(line).toContain("payout");
    expect(line).toContain("currencies=XAF");
  });

  it("returns null descriptor for unknown provider", () => {
    expect(describeCapabilities("never-registered")).toBeNull();
  });

  it("builds a report even when no live fetch is requested", async () => {
    const report = await buildCapabilitiesReport("sample-provider", "sandbox");
    expect(report).toBeTruthy();
    expect(report?.matrix.payment).toBe("supported");
    expect(report?.matrix.batchPayout).toBe("unsupported");
    expect(report?.matrix.health).toBe("indeterminate");
    expect(report?.live).toBeUndefined();
    expect(report?.warnings).toBeDefined();
  });

  it("returns null report for an unknown provider", async () => {
    const report = await buildCapabilitiesReport("never-registered");
    expect(report).toBeNull();
  });

  it("does not call registerBuiltinAdapter for invalid adapters", () => {
    // Invalid adapters (empty currencies) are rejected by validation
    // when registered — capability warnings are defensive code that
    // exists for adapters that bypass registration. Pin the contract
    // here so the rejection remains the primary signal.
    expect(() =>
      registerBuiltinAdapter({
        ...sampleAdapter,
        name: "partial-provider",
        getCapabilities() {
          return {
            ...sampleAdapter.getCapabilities(),
            supportedCurrencies: [],
            defaultCurrency: "",
          };
        },
      }),
    ).toThrow(/supportedCurrencies/);
  });

  it("merges live probe outcomes into the matrix", async () => {
    const fakeFetch: typeof fetch = (async () =>
      new Response("", { status: 200 })) as unknown as typeof fetch;
    const report = await buildCapabilitiesReport(
      "sample-provider",
      "sandbox",
      fakeFetch,
    );
    expect(report?.live?.reachable).toBe(true);
    expect(report?.matrix.payment).toBe("supported");
    expect(report?.matrix.health).toBe("supported");
  });

  it("marks indeterminate when endpoint is down", async () => {
    const fakeFetch: typeof fetch = (async () =>
      new Response("", { status: 503 })) as unknown as typeof fetch;
    const report = await buildCapabilitiesReport(
      "sample-provider",
      "sandbox",
      fakeFetch,
    );
    expect(report?.live?.reachable).toBe(false);
    // Static declares the capability, but live unreachable ⇒ indeterminate.
    expect(report?.matrix.payment).toBe("indeterminate");
    // Health is pre-declared as supported when there is a live probe, so
    // an unreachable endpoint flips the row to indeterminate, not unsupported.
    expect(report?.matrix.health).toBe("indeterminate");
  });

  it("handles fetch errors gracefully", async () => {
    const fakeFetch: typeof fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const report = await buildCapabilitiesReport(
      "sample-provider",
      "sandbox",
      fakeFetch,
    );
    expect(report?.live?.reachable).toBe(false);
    expect(report?.live?.httpStatus).toBeNull();
  });
});
