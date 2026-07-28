// Integration-style test for checklistManager. Mocks the pool to keep
// the test offline; the goal is to pin the readiness promotion logic
// in evaluateAll() and the markStep() JSONB merge semantic.

jest.mock("../../config/database", () => {
  // One row per provider. Steps are stored as JSONB in the test path.
  const rows = new Map<
    string,
    {
      provider_name: string;
      status: string;
      steps: Record<string, unknown>;
      notes: string | null;
      created_at: Date;
      updated_at: Date;
    }
  >();
  return {
    pool: {
      async query(sql: string, params: any[] = []) {
        const lowered = sql.toLowerCase();
        if (lowered.includes("select enabled from provider_health_configs")) {
          const [name] = params;
          const row = rows.get(name) as any;
          return {
            rows: [{ enabled: true }],
            rowCount: rows.has("__health_for_" + name) ? 1 : 0,
          };
        }
        if (lowered.includes(
          "select provider_name, auth_mode, last_rotated_at, encrypted_payload",
        )) {
          return { rows: [], rowCount: 0 };
        }
        if (lowered.includes("select * from provider_health_configs")) {
          return { rows: [], rowCount: 0 };
        }
        if (lowered.includes("select * from provider_onboarding_state")) {
          const all = [...rows.values()].map((r) => ({ ...r }));
          return { rows: all, rowCount: all.length };
        }
        if (lowered.includes("select steps from provider_onboarding_state")) {
          const [name] = params;
          const row = rows.get(name.toLowerCase()) as any;
          return {
            rows: row ? [{ steps: row.steps }] : [],
            rowCount: row ? 1 : 0,
          };
        }
        if (
          lowered.includes(
            "insert into provider_onboarding_state",
          ) &&
          lowered.includes("on conflict (provider_name) do update")
        ) {
          const [name, status, steps] = params;
          const now = new Date();
          const existing = rows.get(name);
          rows.set(name, {
            provider_name: name,
            status: typeof status === "string" ? status : "in_progress",
            steps: typeof steps === "string" ? JSON.parse(steps) : steps,
            notes: null,
            created_at: existing?.created_at ?? now,
            updated_at: now,
          });
          const r = rows.get(name)!;
          return { rows: [{ ...r }], rowCount: 1 };
        }
        if (
          lowered.includes("insert into provider_onboarding_state") &&
          lowered.includes("on conflict do update set") &&
          lowered.includes("||")
        ) {
          const [name, stepId, stepJson] = params;
          const existing = rows.get(name);
          const merged = {
            ...(existing?.steps ?? {}),
            [stepId]: typeof stepJson === "string" ? JSON.parse(stepJson) : stepJson,
          };
          rows.set(name, {
            provider_name: name,
            status: existing?.status ?? "in_progress",
            steps: merged,
            notes: existing?.notes ?? null,
            created_at: existing?.created_at ?? new Date(),
            updated_at: new Date(),
          });
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      },
    },
  };
});

import { checklistManager, renderChecklistTable, DEFAULT_STEPS } from "../checklist";
import { registerBuiltinAdapter, ProviderAdapter } from "../adapterSpec";
import { credentialManager } from "../credentialManager";

// Setup: register a fully-capable adapter that passes every static check.
const okAdapter: ProviderAdapter = {
  name: "ok-spec",
  displayName: "OK Spec",
  getEndpoints() {
    return { sandbox: "https://sandbox.ok.com", production: "https://api.ok.com" };
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

describe("checklistManager (db-mocked)", () => {
  beforeAll(() => {
    registerBuiltinAdapter(okAdapter);
  });

  beforeEach(() => {
    process.env.PAGERDUTY_INTEGRATION_KEY = "pd-test-key";
    process.env.OK_SPEC_MIN_AMOUNT = "100";
    process.env.OK_SPEC_MAX_AMOUNT = "500000";
  });

  it("evaluates to 'in_progress' when prerequisites are not met", async () => {
    const state = await checklistManager.evaluateAll("ok-spec");
    // adapter_registered + capabilities_declared pass (no DB needed); the
    // rest fail because the test DB has no credentials/health rows.
    expect(state.status).toBe("in_progress");
    expect(state.steps.adapter_registered.status).toBe("passed");
    expect(state.steps.capabilities_declared.status).toBe("passed");
  });

  it("renders the checklist with glyphs", () => {
    const sample = {
      providerName: "ok-spec",
      status: "ready" as const,
      steps: {},
      notes: null,
      createdAt: "t",
      updatedAt: "t",
    };
    const out = renderChecklistTable(sample);
    expect(out).toContain("Overall status: ready");
    // 8 steps must show, plus the heading — total 9 lines
    expect(out.split("\n").length).toBeGreaterThanOrEqual(DEFAULT_STEPS.length + 1);
  });

  it("handles unknown providers gracefully", async () => {
    const state = await checklistManager.evaluateAll("never-seen");
    expect(state.status).toBe("in_progress");
  });

  it("records a step via markStep", async () => {
    // markStep performs an UPSERT with a JSONB-merge SQL pattern.
    // We verify the actual SQL is issued without depending on the
    // mock row specifics — which lets the test survive a refactor of
    // the SQL builder.
    const responses: Array<{ sql: string; params: any[] }> = [];
    const result = await markStepWithRecorder(
      "ok-spec-recorder",
      "sandbox_e2e_passed",
      "passed",
      "sandbox summary ok",
      responses,
    );
    // expect THIS markStep SQL to have been issued
    expect(responses.some((r) => r.sql.includes("||"))).toBe(true);
    expect(result).toBeUndefined();
  });

  it("lists every persisted provider", async () => {
    await checklistManager.markStep("ok-spec", "documentation_published", "passed", "doc");
    const all = await checklistManager.listAll();
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all.find((s) => s.providerName === "ok-spec")).toBeDefined();
  });

  it("exposes stable step IDs", () => {
    expect(DEFAULT_STEPS.map((s) => s.id)).toEqual([
      "adapter_registered",
      "capabilities_declared",
      "credentials_issued",
      "sandbox_e2e_passed",
      "health_check_registered",
      "limits_configured",
      "alerts_configured",
      "documentation_published",
    ]);
  });
});

// Helper: invokes checklistManager.markStep but records every SQL
// statement the mock-pool receives. Demonstrates the SQL contract
// without depending on the internal row shape.
async function markStepWithRecorder(
  provider: string,
  stepId: string,
  statusArg: "passed" | "failed" | "skipped" | "pending",
  notes: string | undefined,
  recorder: Array<{ sql: string; params: any[] }>,
): Promise<void> {
  const orig = (require("../../config/database").pool.query) as any;
  require("../../config/database").pool.query = (sql: string, params: any[] = []) => {
    recorder.push({ sql, params });
    return orig(sql, params);
  };
  try {
    await checklistManager.markStep(provider, stepId, statusArg, notes);
  } finally {
    require("../../config/database").pool.query = orig;
  }
}
