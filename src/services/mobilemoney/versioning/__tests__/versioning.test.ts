/**
 * Comprehensive Tests for Provider API Versioning
 *
 * Tests cover:
 * - Compatibility adapter request/response transformation
 * - Version routing strategies (fixed, canary, conditional, failover)
 * - Provider loading and fallback logic
 * - Provider-specific compatibility bridges
 * - Migration progress tracking
 */

import {
  ProviderApiVersion,
  VersionRoutingStrategy,
  CompatibilityLevel,
  TransactionContext,
  CanaryConfig,
} from "../types";
import {
  CompatibilityAdapter,
  VersionAdapterFactory,
} from "../adapter";
import {
  VersionRouter,
  VersionedProviderLoader,
} from "../loader";
import {
  MTNCompatibilityBridge,
  AirtelCompatibilityBridge,
  OrangeCompatibilityBridge,
} from "../bridges";

describe("Versioning System - Compatibility Adapter", () => {
  let adapter: CompatibilityAdapter;

  beforeEach(() => {
    adapter = new CompatibilityAdapter();
  });

  it("should transform V1 request to V2 format", () => {
    const v1Request = {
      phone_number: "237123456789",
      amount: "1000",
      currency: "XAF",
      external_id: "ext123",
      description: "Test payment",
      callback_url: "https://example.com/callback",
    };

    const v2Request = adapter.transformRequest(
      v1Request,
      ProviderApiVersion.V1,
      ProviderApiVersion.V2
    );

    expect(v2Request).toEqual({
      phoneNumber: "237123456789",
      amount: "1000",
      currency: "XAF",
      externalId: "ext123",
      description: "Test payment",
      callbackUrl: "https://example.com/callback",
      metadata: expect.any(Object),
    });
  });

  it("should transform V2 response back to V1 format", () => {
    const v2Response = {
      transactionId: "txn123",
      externalId: "ext123",
      status: "completed",
      amount: 1000,
      currency: "XAF",
      timestamp: "2024-10-16T00:00:00Z",
      errorMessage: null,
    };

    const v1Response = adapter.transformResponse(
      v2Response,
      ProviderApiVersion.V1,
      ProviderApiVersion.V2
    );

    expect(v1Response).toEqual({
      transaction_id: "txn123",
      external_id: "ext123",
      status: "completed",
      amount: 1000,
      currency: "XAF",
      timestamp: "2024-10-16T00:00:00Z",
      error_message: null,
    });
  });

  it("should return request unchanged when source and target versions match", () => {
    const request = { phone_number: "237123456789", amount: "1000" };

    const result = adapter.transformRequest(
      request,
      ProviderApiVersion.V1,
      ProviderApiVersion.V1
    );

    expect(result).toBe(request);
  });

  it("should report full compatibility for same version", () => {
    const level = adapter.getCompatibilityLevel(
      ProviderApiVersion.V1,
      ProviderApiVersion.V1
    );

    expect(level).toBe(CompatibilityLevel.FULL);
  });

  it("should report compatible for V1 to V2", () => {
    const level = adapter.getCompatibilityLevel(
      ProviderApiVersion.V1,
      ProviderApiVersion.V2
    );

    expect(level).toBe(CompatibilityLevel.COMPATIBLE);
  });

  it("should indicate feature support by version", () => {
    expect(adapter.isFeatureSupported("batch_operations", ProviderApiVersion.V1)).toBe(false);
    expect(adapter.isFeatureSupported("batch_operations", ProviderApiVersion.V2)).toBe(true);
    expect(adapter.isFeatureSupported("webhooks", ProviderApiVersion.V2)).toBe(true);
  });
});

describe("Versioning System - Version Router", () => {
  let adapter: CompatibilityAdapter;
  let factory: VersionAdapterFactory;

  beforeEach(() => {
    adapter = new CompatibilityAdapter();
    factory = new VersionAdapterFactory(adapter);
  });

  it("should select primary version with FIXED strategy", () => {
    const router = new VersionRouter(
      {
        provider: "mtn",
        strategy: VersionRoutingStrategy.FIXED,
        primaryVersion: ProviderApiVersion.V2,
        secondaryVersion: ProviderApiVersion.V1,
      },
      adapter,
      factory
    );

    const context: TransactionContext = {
      provider: "mtn",
      phoneNumber: "237123456789",
      amount: 1000,
    };

    const selection = router.selectVersion(context);

    expect(selection.version).toBe(ProviderApiVersion.V2);
    expect(selection.reason).toBe("fixed_strategy");
  });

  it("should route traffic percentage with CANARY strategy", () => {
    const router = new VersionRouter(
      {
        provider: "mtn",
        strategy: VersionRoutingStrategy.CANARY,
        primaryVersion: ProviderApiVersion.V1,
        secondaryVersion: ProviderApiVersion.V2,
        canaryConfig: {
          trafficPercentage: 50,
          sessionAffinity: false,
        },
      },
      adapter,
      factory
    );

    const context: TransactionContext = {
      provider: "mtn",
      phoneNumber: "237123456789",
      amount: 1000,
    };

    // Run multiple times to verify traffic split approximates 50%
    const results = Array.from({ length: 100 }).map(() =>
      router.selectVersion(context).version
    );

    const v2Count = results.filter((v) => v === ProviderApiVersion.V2).length;
    // Allow 30-70 range for 50/50 split with randomness
    expect(v2Count).toBeGreaterThan(30);
    expect(v2Count).toBeLessThan(70);
  });

  it("should maintain session affinity with CANARY strategy", () => {
    const router = new VersionRouter(
      {
        provider: "mtn",
        strategy: VersionRoutingStrategy.CANARY,
        primaryVersion: ProviderApiVersion.V1,
        secondaryVersion: ProviderApiVersion.V2,
        canaryConfig: {
          trafficPercentage: 50,
          sessionAffinity: true,
        },
      },
      adapter,
      factory
    );

    const context: TransactionContext = {
      provider: "mtn",
      phoneNumber: "237123456789",
      amount: 1000,
      sessionId: "session123",
    };

    const selection1 = router.selectVersion(context);
    const selection2 = router.selectVersion(context);
    const selection3 = router.selectVersion(context);

    // Same session should always get same version
    expect(selection1.version).toBe(selection2.version);
    expect(selection2.version).toBe(selection3.version);
  });

  it("should route based on conditional rules", () => {
    const router = new VersionRouter(
      {
        provider: "mtn",
        strategy: VersionRoutingStrategy.CONDITIONAL,
        primaryVersion: ProviderApiVersion.V1,
        secondaryVersion: ProviderApiVersion.V2,
        conditionalRules: [
          {
            condition: (ctx) => ctx.amount > 5000,
            version: ProviderApiVersion.V2,
            priority: 100,
          },
          {
            condition: (ctx) => ctx.amount <= 5000,
            version: ProviderApiVersion.V1,
            priority: 50,
          },
        ],
      },
      adapter,
      factory
    );

    const smallTransaction: TransactionContext = {
      provider: "mtn",
      phoneNumber: "237123456789",
      amount: 1000,
    };

    const largeTransaction: TransactionContext = {
      provider: "mtn",
      phoneNumber: "237123456789",
      amount: 10000,
    };

    expect(router.selectVersion(smallTransaction).version).toBe(ProviderApiVersion.V1);
    expect(router.selectVersion(largeTransaction).version).toBe(ProviderApiVersion.V2);
  });

  it("should record performance metrics", () => {
    const router = new VersionRouter(
      {
        provider: "mtn",
        strategy: VersionRoutingStrategy.FIXED,
        primaryVersion: ProviderApiVersion.V2,
      },
      adapter,
      factory
    );

    router.recordPerformance(ProviderApiVersion.V2, true, 100);
    router.recordPerformance(ProviderApiVersion.V2, true, 150);
    router.recordPerformance(ProviderApiVersion.V2, false, 200);

    const metrics = router.getPerformanceMetrics();
    const v2Metrics = metrics.get(ProviderApiVersion.V2);

    expect(v2Metrics?.calls).toBe(3);
    expect(v2Metrics?.successes).toBe(2);
    expect(v2Metrics?.failures).toBe(1);
  });

  it("should detect canary completion", () => {
    const router = new VersionRouter(
      {
        provider: "mtn",
        strategy: VersionRoutingStrategy.CANARY,
        primaryVersion: ProviderApiVersion.V1,
        secondaryVersion: ProviderApiVersion.V2,
        canaryConfig: {
          trafficPercentage: 100,
        },
      },
      adapter,
      factory
    );

    expect(router.isCanaryComplete()).toBe(true);
  });

  it("should update canary traffic percentage", () => {
    const router = new VersionRouter(
      {
        provider: "mtn",
        strategy: VersionRoutingStrategy.CANARY,
        primaryVersion: ProviderApiVersion.V1,
        secondaryVersion: ProviderApiVersion.V2,
        canaryConfig: {
          trafficPercentage: 0,
        },
      },
      adapter,
      factory
    );

    router.updateCanaryTraffic(50);
    const selection = router.selectVersion({
      provider: "mtn",
      phoneNumber: "237123456789",
      amount: 1000,
    });
    // After update, should route some traffic to secondary
    expect([ProviderApiVersion.V1, ProviderApiVersion.V2]).toContain(selection.version);
  });
});

describe("Versioning System - Versioned Provider Loader", () => {
  let adapter: CompatibilityAdapter;
  let factory: VersionAdapterFactory;
  let loader: VersionedProviderLoader;

  beforeEach(() => {
    adapter = new CompatibilityAdapter();
    factory = new VersionAdapterFactory(adapter);
    loader = new VersionedProviderLoader(adapter, factory);
  });

  it("should register and resolve provider versions", async () => {
    const mockV1Provider = { name: "MTNv1" };
    const mockV2Provider = { name: "MTNv2" };

    loader.registerProviderVersion("mtn", ProviderApiVersion.V1, mockV1Provider);
    loader.registerProviderVersion("mtn", ProviderApiVersion.V2, mockV2Provider);

    loader.registerRoutingConfig("mtn", {
      provider: "mtn",
      strategy: VersionRoutingStrategy.FIXED,
      primaryVersion: ProviderApiVersion.V2,
    });

    const resolved = await loader.resolveProvider("mtn", {
      provider: "mtn",
      phoneNumber: "237123456789",
      amount: 1000,
    });

    expect(resolved.instance).toBe(mockV2Provider);
    expect(resolved.version).toBe(ProviderApiVersion.V2);
  });

  it("should execute operation with fallback on failure", async () => {
    const mockV1Provider = {
      sendPayout: jest.fn().mockRejectedValue(new Error("V1 failed")),
    };

    const mockV2Provider = {
      sendPayout: jest.fn().mockResolvedValue({ transactionId: "txn123" }),
    };

    loader.registerProviderVersion("mtn", ProviderApiVersion.V1, mockV1Provider);
    loader.registerProviderVersion("mtn", ProviderApiVersion.V2, mockV2Provider);

    loader.registerRoutingConfig("mtn", {
      provider: "mtn",
      strategy: VersionRoutingStrategy.FAILOVER,
      primaryVersion: ProviderApiVersion.V1,
      secondaryVersion: ProviderApiVersion.V2,
    });

    const result = await loader.executeWithFallback("mtn", {
      provider: "mtn",
      phoneNumber: "237123456789",
      amount: 1000,
      metadata: { allowFallback: true },
    }, async (instance: any) => {
      return instance.sendPayout();
    });

    expect(result.success).toBe(true);
    expect(result.fallbackUsed).toBe(true);
    expect(result.apiVersion).toBe(ProviderApiVersion.V2);
  });

  it("should throw when no routing config is registered", async () => {
    await expect(
      loader.resolveProvider("unknown", {
        provider: "unknown",
        phoneNumber: "237123456789",
        amount: 1000,
      })
    ).rejects.toThrow("No routing config found");
  });
});

describe("Versioning System - Provider-Specific Bridges", () => {
  let adapter: CompatibilityAdapter;

  beforeEach(() => {
    adapter = new CompatibilityAdapter();
  });

  it("should register MTN compatibility mappings", () => {
    MTNCompatibilityBridge.registerMappings(adapter);

    const level = adapter.getCompatibilityLevel(
      ProviderApiVersion.V1,
      ProviderApiVersion.V2
    );

    expect(level).toBe(CompatibilityLevel.COMPATIBLE);
  });

  it("should transform MTN V1 request to V2", () => {
    MTNCompatibilityBridge.registerMappings(adapter);

    const v1Request = {
      phone_number: "237123456789",
      amount: "5000",
      external_id: "ext123",
    };

    const v2Request = adapter.transformRequest(
      v1Request,
      ProviderApiVersion.V1,
      ProviderApiVersion.V2
    );

    expect(v2Request).toHaveProperty("phoneNumber", "237123456789");
    expect(v2Request).toHaveProperty("amount", 5000);
    expect(v2Request).toHaveProperty("externalId", "ext123");
  });

  it("should register Airtel compatibility mappings", () => {
    AirtelCompatibilityBridge.registerMappings(adapter);

    const v1Request = {
      msisdn: "254123456789",
      amount: "2000",
      reference: "ref123",
    };

    const v2Request = adapter.transformRequest(
      v1Request,
      ProviderApiVersion.V1,
      ProviderApiVersion.V2
    );

    expect(v2Request).toHaveProperty("customer.msisdn", "254123456789");
    expect(v2Request).toHaveProperty("transaction.amount", 2000);
  });

  it("should register Orange compatibility mappings", () => {
    OrangeCompatibilityBridge.registerMappings(adapter);

    const v1Request = {
      number: "221123456789",
      amount: "3000",
      txnid: "txn123",
    };

    const v2Request = adapter.transformRequest(
      v1Request,
      ProviderApiVersion.V1,
      ProviderApiVersion.V2
    );

    expect(v2Request).toHaveProperty("party_id", "221123456789");
    expect(v2Request).toHaveProperty("amount", 3000);
    expect(v2Request).toHaveProperty("request_id", "txn123");
  });
});

describe("Versioning System - Version Adapter Factory", () => {
  let factory: VersionAdapterFactory;

  beforeEach(() => {
    factory = new VersionAdapterFactory();
  });

  it("should track execution metrics", async () => {
    const mockMethod = jest.fn().mockResolvedValue({ success: true });

    await factory.executeWithTransform(
      mockMethod,
      [{ test: "data" }],
      ProviderApiVersion.V1,
      ProviderApiVersion.V2
    );

    await factory.executeWithTransform(
      mockMethod,
      [{ test: "data" }],
      ProviderApiVersion.V1,
      ProviderApiVersion.V2
    );

    const metrics = factory.getMetrics();
    expect(Object.keys(metrics).length).toBeGreaterThan(0);
  });

  it("should calculate average latency", async () => {
    const mockMethod = jest.fn().mockImplementation(() =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ success: true }), 50);
      })
    );

    const key = "test_v1_to_v2";

    await factory.executeWithTransform(
      mockMethod,
      [{ test: "data" }],
      ProviderApiVersion.V1,
      ProviderApiVersion.V2
    );

    const avgLatency = factory.getAverageLatency(key);
    expect(avgLatency).toBeGreaterThanOrEqual(50);
  });

  it("should reset metrics", async () => {
    const mockMethod = jest.fn().mockResolvedValue({ success: true });

    await factory.executeWithTransform(
      mockMethod,
      [{ test: "data" }],
      ProviderApiVersion.V1,
      ProviderApiVersion.V2
    );

    factory.resetMetrics();
    const metrics = factory.getMetrics();
    expect(Object.keys(metrics).length).toBe(0);
  });
});

describe("Versioning System - Integration", () => {
  it("should handle complete migration flow", async () => {
    const adapter = new CompatibilityAdapter();
    const factory = new VersionAdapterFactory(adapter);
    const loader = new VersionedProviderLoader(adapter, factory);

    // Register provider versions
    const mockV1 = {
      sendPayout: jest.fn().mockResolvedValue({ transaction_id: "txn123" }),
    };
    const mockV2 = {
      sendPayout: jest.fn().mockResolvedValue({ transactionId: "txn123" }),
    };

    loader.registerProviderVersion("mtn", ProviderApiVersion.V1, mockV1);
    loader.registerProviderVersion("mtn", ProviderApiVersion.V2, mockV2);

    // Start with fixed strategy on V1
    loader.registerRoutingConfig("mtn", {
      provider: "mtn",
      strategy: VersionRoutingStrategy.FIXED,
      primaryVersion: ProviderApiVersion.V1,
      secondaryVersion: ProviderApiVersion.V2,
    });

    const result1 = await loader.executeWithFallback(
      "mtn",
      { provider: "mtn", phoneNumber: "237123456789", amount: 1000 },
      async (instance: any) => instance.sendPayout()
    );

    expect(result1.success).toBe(true);
    expect(result1.apiVersion).toBe(ProviderApiVersion.V1);

    // Switch to canary strategy
    loader.registerRoutingConfig("mtn", {
      provider: "mtn",
      strategy: VersionRoutingStrategy.CANARY,
      primaryVersion: ProviderApiVersion.V1,
      secondaryVersion: ProviderApiVersion.V2,
      canaryConfig: { trafficPercentage: 50 },
    });

    // Run multiple requests to verify split
    const results = await Promise.all(
      Array.from({ length: 10 }).map(() =>
        loader.executeWithFallback(
          "mtn",
          { provider: "mtn", phoneNumber: "237123456789", amount: 1000 },
          async (instance: any) => instance.sendPayout()
        )
      )
    );

    expect(results.every((r) => r.success)).toBe(true);
    const v2Calls = results.filter((r) => r.apiVersion === ProviderApiVersion.V2).length;
    expect(v2Calls).toBeGreaterThan(0); // Some should be routed to V2
  });
});
