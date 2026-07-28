import { healthCheckSetup } from "../healthCheckSetup";

jest.mock("../../config/database", () => {
  const store = new Map<
    string,
    {
      id: string;
      provider_name: string;
      ping_url: string;
      timeout_ms: number;
      enabled: boolean;
      created_at: Date;
      updated_at: Date;
    }
  >();
  let counter = 0;
  return {
    pool: {
      async query(sql: string, params: any[] = []) {
        const lowered = sql.toLowerCase();
        if (lowered.includes("select count(*) as count from provider_health_configs")) {
          return {
            rows: [
              {
                count: [...store.values()].filter((r) => r.enabled).length.toString(),
              },
            ],
            rowCount: 1,
          };
        }
        if (lowered.includes("select enabled from provider_health_configs where provider_name")) {
          const [name] = params;
          const row = store.get(name);
          return { rows: row ? [{ enabled: row.enabled }] : [], rowCount: row ? 1 : 0 };
        }
        if (lowered.includes("insert into provider_health_configs")) {
          const [name, url, timeoutMs] = params;
          const now = new Date();
          const existing = store.get(name);
          const row = {
            id: existing?.id ?? `uuid-${++counter}`,
            provider_name: name,
            ping_url: url,
            timeout_ms: timeoutMs,
            enabled: true,
            created_at: existing?.created_at ?? now,
            updated_at: now,
          };
          store.set(name, row);
          return { rows: [row], rowCount: 1 };
        }
        if (lowered.includes("update provider_health_configs set enabled = false")) {
          const [name] = params;
          const row = store.get(name);
          if (!row) return { rows: [], rowCount: 0 };
          row.enabled = false;
          row.updated_at = new Date();
          return { rows: [{ ...row }], rowCount: 1 };
        }
        if (lowered.includes("select * from provider_health_configs where enabled = true")) {
          return {
            rows: [...store.values()]
              .filter((r) => r.enabled)
              .map((r) => ({
                id: r.id,
                provider_name: r.provider_name,
                ping_url: r.ping_url,
                timeout_ms: r.timeout_ms,
                enabled: r.enabled,
                created_at: r.created_at,
                updated_at: r.updated_at,
              })),
            rowCount: store.size,
          };
        }
        return { rows: [], rowCount: 0 };
      },
    },
  };
});

describe("healthCheckSetup", () => {
  it("registers a new provider", async () => {
    const r = await healthCheckSetup.registerProviderForHealthCheck({
      providerName: "newprov",
      pingUrl: "https://api.newprov/health",
      timeoutMs: 5000,
    });
    expect(r.providerName).toBe("newprov");
    expect(r.pingUrl).toBe("https://api.newprov/health");
    expect(r.enabled).toBe(true);
  });

  it("updates existing provider on second register call", async () => {
    await healthCheckSetup.registerProviderForHealthCheck({
      providerName: "swap",
      pingUrl: "https://old/health",
      timeoutMs: 3000,
    });
    const updated = await healthCheckSetup.registerProviderForHealthCheck({
      providerName: "swap",
      pingUrl: "https://new/health",
      timeoutMs: 4500,
    });
    expect(updated.pingUrl).toBe("https://new/health");
    expect(updated.timeoutMs).toBe(4500);
  });

  it("disables a provider", async () => {
    await healthCheckSetup.registerProviderForHealthCheck({
      providerName: "killme",
      pingUrl: "https://killme/health",
      timeoutMs: 5000,
    });
    const ok = await healthCheckSetup.disableProvider("killme");
    expect(ok).toBe(true);
    const list = await healthCheckSetup.listActiveConfigs();
    expect(list.find((r) => r.providerName === "killme")).toBeUndefined();
  });

  it("union DEFAULT_PROVIDERS with DB rows on resolveHealthConfigs", async () => {
    // 'mtn' is part of the DEFAULT_PROVIDERS. Registering an override
    // should win for the same name.
    await healthCheckSetup.registerProviderForHealthCheck({
      providerName: "mtn",
      pingUrl: "https://override.mtn/health",
      timeoutMs: 7500,
    });
    // Plus a brand-new provider that isn't in DEFAULT_PROVIDERS.
    await healthCheckSetup.registerProviderForHealthCheck({
      providerName: "vodacom",
      pingUrl: "https://override.vodacom/health",
      timeoutMs: 4000,
    });

    const merged = await healthCheckSetup.resolveHealthConfigs();
    expect(merged.length).toBeGreaterThanOrEqual(4);
    const mtn = merged.find((c) => c.name === "mtn");
    expect(mtn?.pingUrl).toBe("https://override.mtn/health");
    expect(mtn?.timeoutMs).toBe(7500);
    const vodacom = merged.find((c) => c.name === "vodacom");
    expect(vodacom?.pingUrl).toBe("https://override.vodacom/health");
  });
});
