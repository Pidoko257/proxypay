import {
  validateAdapter,
  registerBuiltinAdapter,
  listBuiltinAdapters,
  findBuiltinAdapter,
  generateAdapterBoilerplate,
  ProviderAdapter,
} from "../adapterSpec";

const validBase: ProviderAdapter = {
  name: "vodacom",
  displayName: "Vodacom M-Pesa (test)",
  getEndpoints() {
    return {
      sandbox: "https://sandbox.vodacom.example.com",
      production: "https://api.vodacom.example.com",
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
      supportedCurrencies: ["XAF", "USD"],
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
      async getTransactionStatus() {
        return { status: "completed" };
      },
    };
  },
};

describe("adapterSpec", () => {
  describe("validateAdapter", () => {
    it("accepts a well-formed adapter", () => {
      expect(() => validateAdapter(validBase)).not.toThrow();
    });

    it("rejects names with invalid characters", () => {
      expect(() =>
        validateAdapter({
          ...validBase,
          name: "Bad-Provider!",
        }),
      ).toThrow(/name must be lowercase/);
    });

    it("rejects names shorter than 2 chars", () => {
      expect(() =>
        validateAdapter({ ...validBase, name: "x" }),
      ).toThrow(/name must be lowercase/);
    });

    it("rejects empty displayName", () => {
      expect(() =>
        validateAdapter({ ...validBase, displayName: "" }),
      ).toThrow(/displayName must be at least 2 characters/);
    });

    it("rejects non-HTTPS sandbox URLs", () => {
      expect(() =>
        validateAdapter({
          ...validBase,
          getEndpoints() {
            return {
              sandbox: "ftp://nope",
              production: "https://ok.example.com",
            };
          },
        }),
      ).toThrow(/sandbox.*HTTPS/);
    });

    it("rejects missing defaultCurrency when supportedCurrencies is set", () => {
      expect(() =>
        validateAdapter({
          ...validBase,
          getCapabilities() {
            return {
              ...validBase.getCapabilities(),
              defaultCurrency: "EUR",
              supportedCurrencies: ["XAF"],
            };
          },
        }),
      ).toThrow(/defaultCurrency/);
    });

    it("rejects empty supportedCurrencies", () => {
      expect(() =>
        validateAdapter({
          ...validBase,
          getCapabilities() {
            return {
              ...validBase.getCapabilities(),
              supportedCurrencies: [],
            };
          },
        }),
      ).toThrow(/supportedCurrencies/);
    });

    it("rejects batchPayout without positive maxBatchSize", () => {
      expect(() =>
        validateAdapter({
          ...validBase,
          getCapabilities() {
            return {
              ...validBase.getCapabilities(),
              supportsBatchPayout: true,
              maxBatchSize: undefined,
            };
          },
        }),
      ).toThrow(/maxBatchSize/);
    });

    it("rejects authMode mismatch with getRequiredCredentialFields", () => {
      expect(() =>
        validateAdapter({
          ...validBase,
          getCapabilities() {
            return { ...validBase.getCapabilities(), authMode: "web" };
          },
          getRequiredCredentialFields() {
            return ["apiKey", "apiSecret"] as const; // wrong for web
          },
        }),
      ).toThrow(/authMode "web" requires field "username"/);
    });

    it("surfaces lucky fail when getCapabilities throws", () => {
      expect(() =>
        validateAdapter({
          ...validBase,
          getCapabilities() {
            throw new Error("boom");
          },
        }),
      ).toThrow(/getCapabilities/);
    });
  });

  describe("registry", () => {
    it("registers, lists, and finds adapters", () => {
      registerBuiltinAdapter({ ...validBase, name: "registry-test-a" });
      const all = listBuiltinAdapters();
      expect(all.some((a) => a.name === "registry-test-a")).toBe(true);
      expect(findBuiltinAdapter("registry-test-a")).toBeDefined();
      expect(findBuiltinAdapter("missing")).toBeUndefined();
    });

    it("replaces an adapter with the same name rather than appending", () => {
      const original = { ...validBase, name: "registry-test-b", displayName: "Original" };
      const replacement = { ...validBase, name: "registry-test-b", displayName: "Replacement" };
      registerBuiltinAdapter(original);
      registerBuiltinAdapter(replacement);
      const found = findBuiltinAdapter("registry-test-b");
      expect(found?.displayName).toBe("Replacement");
      expect(
        listBuiltinAdapters().filter((a) => a.name === "registry-test-b").length,
      ).toBe(1);
    });

    it("rejects malformed adapters at registration time", () => {
      expect(() =>
        registerBuiltinAdapter({
          ...validBase,
          name: "Bad Name",
        }),
      ).toThrow();
    });
  });

  describe("generateAdapterBoilerplate", () => {
    it("emits a deterministic template with sanitized lowercase name", () => {
      // The implementation strips non-[a-z0-9_-] characters and lowercases.
      const tpl = generateAdapterBoilerplate("New Provider!@#");
      expect(tpl).toMatch(/name:\s*"newprovider"/);
      expect(tpl).toContain("getCapabilities()");
      expect(tpl).toContain("getEndpoints()");
      // No capitals — they get sanitized out.
      expect(tpl).not.toMatch(/displayName:\s*"New/);
    });

    it("preserves valid names verbatim", () => {
      const tpl = generateAdapterBoilerplate("vodacom-tz");
      expect(tpl).toContain('name: "vodacom-tz"');
    });
  });
});
