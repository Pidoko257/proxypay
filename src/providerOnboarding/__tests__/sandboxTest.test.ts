import {
  runSandboxTests,
  recordSandboxReport,
} from "../sandboxTest";
import {
  registerBuiltinAdapter,
  ProviderAdapter,
  ProviderAdapterInstance,
} from "../adapterSpec";

const instance: ProviderAdapterInstance = {
  async requestPayment(phone, amount) {
    expect(phone).toMatch(/^\+/);
    expect(Number(amount)).toBeGreaterThan(0);
    return { success: true, data: { id: "pay-1" } };
  },
  async sendPayout() {
    return { success: true, data: { id: "po-1" } };
  },
  async getTransactionStatus() {
    return { status: "completed" };
  },
};

const goodAdapter: ProviderAdapter = {
  name: "good-adapter",
  displayName: "Good Adapter",
  getEndpoints() {
    return {
      sandbox: "https://sandbox.example.com",
      production: "https://api.example.com",
    };
  },
  getCapabilities() {
    return {
      supportsPayment: true,
      supportsPayout: true,
      supportsBatchPayout: false,
      supportsStatusQuery: true,
      supportsBalance: false,
      authMode: "direct",
      supportedCurrencies: ["XAF"],
      defaultCurrency: "XAF",
    };
  },
  getRequiredCredentialFields() {
    return ["apiKey", "apiSecret"] as const;
  },
  instantiate() {
    return instance;
  },
};

const failingAdapter: ProviderAdapter = {
  ...goodAdapter,
  name: "failing-adapter",
  instantiate() {
    return {
      async requestPayment() {
        return { success: false, error: "remote 500" };
      },
      async sendPayout() {
        return { success: false, error: "remote 500" };
      },
      async getTransactionStatus() {
        return { status: "unknown" };
      },
    };
  },
};

jest.mock("../checklist", () => ({
  checklistManager: {
    async markStep() {
      return null;
    },
  },
}));

beforeAll(() => {
  registerBuiltinAdapter(goodAdapter);
  registerBuiltinAdapter(failingAdapter);
});

describe("sandboxTest", () => {
  it("runs the in-process sandbox for a valid adapter", async () => {
    const report = await runSandboxTests("good-adapter");
    expect(report.passed).toBe(true);
    expect(report.results).toHaveLength(3);
    expect(report.results.find((r) => r.operation === "payment")?.success).toBe(
      true,
    );
    expect(
      report.results.find((r) => r.operation === "statusQuery")?.success,
    ).toBe(true);
  });

  it("reports failures when an adapter returns errors", async () => {
    const report = await runSandboxTests("failing-adapter");
    expect(report.passed).toBe(false);
    expect(report.results.find((r) => r.operation === "payment")?.success).toBe(
      false,
    );
  });

  it("handles unknown provider names", async () => {
    const report = await runSandboxTests("does-not-exist-anywhere");
    expect(report.passed).toBe(false);
    expect(report.results[0].error).toMatch(/no builtin adapter/);
  });

  it("catches thrown errors from instantiate()", async () => {
    registerBuiltinAdapter({
      ...goodAdapter,
      name: "throws-adapter-fixture",
      instantiate() {
        throw new Error("nope");
      },
    });
    const report = await runSandboxTests("throws-adapter-fixture");
    expect(report.passed).toBe(false);
    expect(report.results[0].error).toMatch(/nope/);
  });

  it("records the sandbox report into the checklist", async () => {
    const report = await runSandboxTests("good-adapter");
    await expect(recordSandboxReport(report)).resolves.toBeUndefined();
  });
});
