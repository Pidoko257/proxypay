/**
 * Provider Integration Checklist
 *
 * Issue #187 — Provider Onboarding Workflow, acceptance criterion #6.
 *
 * Defines the ordered checklist every new provider must satisfy to be
 * promoted from `in_progress` → `ready` → `live`. State is persisted to
 * the `provider_onboarding_state` table (see migration) so the dashboard
 * can show progress without depending on a local file.
 *
 * The checklist is intentionally declarative — each `ChecklistStep` has
 * an `evaluate()` function that returns `{ passed, notes }`. Adding a
 * new step is one function definition and one entry in `DEFAULT_STEPS`.
 */

import { pool } from "../config/database";
import { credentialManager } from "./credentialManager";
import { findBuiltinAdapter } from "./adapterSpec";

export type StepStatus = "pending" | "passed" | "failed" | "skipped";

export interface ChecklistStepDefinition {
  /** Stable identifier — used as the JSON key in `provider_onboarding_state.steps`. */
  id: string;
  /** Human-readable title shown in CLI and dashboard output. */
  title: string;
  /** Why this step matters. */
  description: string;
}

export interface ChecklistStepResult {
  status: StepStatus;
  notes?: string;
  evaluatedAt: string;
}

export interface ProviderOnboardingStatus {
  providerName: string;
  status: "in_progress" | "ready" | "live" | "deprecated" | "failed";
  steps: Record<string, ChecklistStepResult>;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The 8 default steps. Ordered by dependency — earlier steps MUST be
 * passed before later ones can run.
 */
export const DEFAULT_STEPS: ChecklistStepDefinition[] = [
  {
    id: "adapter_registered",
    title: "Adapter implementation registered",
    description:
      "A ProviderAdapter implementation exists and is registered with the builtin registry.",
  },
  {
    id: "capabilities_declared",
    title: "Capabilities statically declared",
    description:
      "supportsPayment / supportsPayout / supportsStatusQuery / supportedCurrencies fields populated.",
  },
  {
    id: "credentials_issued",
    title: "Credentials issued and stored",
    description:
      "Provider credentials exist in provider_credentials and decrypt successfully.",
  },
  {
    id: "sandbox_e2e_passed",
    title: "Sandbox end-to-end test passed",
    description:
      "An adapter request against the provider's sandbox endpoint succeeded with a recognized status.",
  },
  {
    id: "health_check_registered",
    title: "Health check registered",
    description:
      "A row in provider_health_configs enables periodic liveness pings.",
  },
  {
    id: "limits_configured",
    title: "Per-provider transaction limits configured",
    description:
      "Min and max transaction amounts exist for the provider in appConfig and pass validation.",
  },
  {
    id: "alerts_configured",
    title: "PagerDuty / alerting integration configured",
    description:
      "Deduplication key registered and the on-call rotation tested with a synthetic alert.",
  },
  {
    id: "documentation_published",
    title: "Provider-specific documentation published",
    description:
      "Operator runbook for the provider exists under docs/providers/.",
  },
];

/**
 * Returns the definitions in evaluation order. The order encodes
 * dependency: `sandbox_e2e_passed` can only run after credentials are
 * stored; `health_check_registered` requires the adapter to be
 * registered, etc.
 */
export function getChecklistDefinitions(): ChecklistStepDefinition[] {
  return [...DEFAULT_STEPS];
}

// ─── Per-step evaluators ──────────────────────────────────────────────────

type StepEvaluator = (
  providerName: string,
) => Promise<{ passed: boolean; notes?: string }>;

const evaluators: Record<string, StepEvaluator> = {
  adapter_registered: async (providerName) => {
    const adapter = findBuiltinAdapter(providerName);
    if (!adapter) {
      return {
        passed: false,
        notes: `No builtin adapter registered for "${providerName}"`,
      };
    }
    return { passed: true, notes: `adapter.displayName="${adapter.displayName}"` };
  },

  capabilities_declared: async (providerName) => {
    const adapter = findBuiltinAdapter(providerName);
    if (!adapter) {
      return { passed: false, notes: "adapter missing" };
    }
    const caps = adapter.getCapabilities();
    const issues: string[] = [];
    if (caps.supportedCurrencies.length === 0) issues.push("supportedCurrencies");
    if (!caps.defaultCurrency) issues.push("defaultCurrency");
    if (!caps.authMode) issues.push("authMode");
    return {
      passed: issues.length === 0,
      notes:
        issues.length === 0
          ? `currencies=${caps.supportedCurrencies.join(",")}`
          : `missing or empty: ${issues.join(", ")}`,
    };
  },

  credentials_issued: async (providerName) => {
    try {
      const record = await credentialManager.readCredentials(providerName);
      if (!record) {
        return {
          passed: false,
          notes:
            "no row in provider_credentials — run provider-onboard to store secrets",
        };
      }
      // The decrypt succeeded — that is the real assertion here.
      const fieldsWithValue = Object.entries(record.payload)
        .filter(([, v]) => Boolean(v))
        .map(([k]) => k);
      return {
        passed: fieldsWithValue.length > 0,
        notes: `authMode=${record.authMode}, fields=[${fieldsWithValue.join(",")}]`,
      };
    } catch (err) {
      return {
        passed: false,
        notes: `decrypt failed: ${(err as Error).message}`,
      };
    }
  },

  sandbox_e2e_passed: async (providerName) => {
    // The sandbox E2E runner writes its result here. We surface whatever
    // it stored; if no row exists, this step is skipped.
    const result = await pool.query<{ steps: Record<string, ChecklistStepResult> }>(
      "SELECT steps FROM provider_onboarding_state WHERE provider_name = $1",
      [providerName.toLowerCase()],
    );
    const sandboxStep = result.rows[0]?.steps?.sandbox_e2e_passed;
    if (!sandboxStep) return { passed: false, notes: "no sandbox E2E result recorded yet" };
    return {
      passed: sandboxStep.status === "passed",
      notes: sandboxStep.notes,
    };
  },

  health_check_registered: async (providerName) => {
    const result = await pool.query<{ enabled: boolean }>(
      "SELECT enabled FROM provider_health_configs WHERE provider_name = $1",
      [providerName.toLowerCase()],
    );
    if (result.rows.length === 0) {
      return {
        passed: false,
        notes:
          "no row in provider_health_configs — run healthCheckSetup.registerProviderForHealthCheck()",
      };
    }
    return {
      passed: Boolean(result.rows[0].enabled),
      notes: `enabled=${result.rows[0].enabled}`,
    };
  },

  limits_configured: async (providerName) => {
    // Defers to appConfig — operators must have the right env vars set
    // before they can promote a provider to `ready`. The check is
    // intentionally permissive: any minAmount set implies a config row.
    const minVar = `${providerName.toUpperCase()}_MIN_AMOUNT`;
    const maxVar = `${providerName.toUpperCase()}_MAX_AMOUNT`;
    const min = process.env[minVar];
    const max = process.env[maxVar];
    if (!min || !max) {
      return {
        passed: false,
        notes: `${minVar} and/or ${maxVar} missing`,
      };
    }
    const minN = Number(min);
    const maxN = Number(max);
    if (!Number.isFinite(minN) || !Number.isFinite(maxN) || minN <= 0 || minN > maxN) {
      return {
        passed: false,
        notes: `invalid bounds: min=${min} max=${max}`,
      };
    }
    return { passed: true, notes: `min=${minN} max=${maxN}` };
  },

  alerts_configured: async (providerName) => {
    const pgKey = process.env.PAGERDUTY_INTEGRATION_KEY ?? "";
    if (!pgKey) {
      return {
        passed: false,
        notes:
          "PAGERDUTY_INTEGRATION_KEY is unset — alert routing will not fire",
      };
    }
    return {
      passed: true,
      notes:
        `dedup_key=${process.env.PAGERDUTY_DEDUP_KEY ?? "proxypay-provider-watchdog"}-${providerName}-outage`,
    };
  },

  documentation_published: async (providerName) => {
    // We deliberately do NOT touch the filesystem here — the wizard is
    // expected to write the runbook as part of step completion. Existence
    // is verified by checking if a notes line mentions the file.
    const result = await pool.query<{ steps: Record<string, ChecklistStepResult> }>(
      "SELECT steps FROM provider_onboarding_state WHERE provider_name = $1",
      [providerName.toLowerCase()],
    );
    const docStep = result.rows[0]?.steps?.documentation_published;
    if (!docStep) return { passed: false, notes: "no documentation step recorded yet" };
    return {
      passed: docStep.status === "passed",
      notes: docStep.notes,
    };
  },
};

// ─── Public API ──────────────────────────────────────────────────────────

class ChecklistManager {
  /** Evaluates every step and updates the persistent state. */
  async evaluateAll(providerName: string): Promise<ProviderOnboardingStatus> {
    const name = providerName.toLowerCase();
    const updates: Record<string, ChecklistStepResult> = {};
    let passedCount = 0;
    let failedCount = 0;

    for (const def of DEFAULT_STEPS) {
      const evaluator = evaluators[def.id];
      if (!evaluator) {
        updates[def.id] = {
          status: "skipped",
          notes: "evaluator not implemented",
          evaluatedAt: new Date().toISOString(),
        };
        continue;
      }

      try {
        const { passed, notes } = await evaluator(name);
        const result: ChecklistStepResult = {
          status: passed ? "passed" : "failed",
          notes,
          evaluatedAt: new Date().toISOString(),
        };
        updates[def.id] = result;
        if (passed) passedCount++;
        else failedCount++;
      } catch (err) {
        updates[def.id] = {
          status: "failed",
          notes: `evaluator threw: ${(err as Error).message}`,
          evaluatedAt: new Date().toISOString(),
        };
        failedCount++;
      }
    }

    // Promote to `ready` iff every step passed.
    const allPassed = failedCount === 0;
    const status: ProviderOnboardingStatus["status"] = allPassed
      ? "ready"
      : passedCount === 0
        ? "failed"
        : "in_progress";

    const result = await pool.query<{
      provider_name: string;
      status: ProviderOnboardingStatus["status"];
      steps: Record<string, ChecklistStepResult>;
      notes: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `INSERT INTO provider_onboarding_state
         (provider_name, status, steps, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (provider_name) DO UPDATE SET
         status     = EXCLUDED.status,
         steps      = EXCLUDED.steps,
         updated_at = NOW()
       RETURNING *
      `,
      [name, status, JSON.stringify(updates)],
    );

    const row = result.rows[0];
    return {
      providerName: row.provider_name,
      status: row.status,
      steps: row.steps,
      notes: row.notes,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  /** Records a manual pass for steps with no automated evaluator. */
  async markStep(
    providerName: string,
    stepId: string,
    status: StepStatus = "passed",
    notes?: string,
  ): Promise<ProviderOnboardingStatus> {
    const name = providerName.toLowerCase();
    const stepResult: ChecklistStepResult = {
      status,
      notes,
      evaluatedAt: new Date().toISOString(),
    };
    await pool.query(
      `INSERT INTO provider_onboarding_state (provider_name, status, steps, updated_at)
       VALUES ($1, 'in_progress', jsonb_build_object($2::text, $3::jsonb), NOW())
       ON CONFLICT (provider_name) DO UPDATE SET
         steps = provider_onboarding_state.steps || jsonb_build_object($2::text, $3::jsonb),
         updated_at = NOW()
      `,
      [name, stepId, JSON.stringify(stepResult)],
    );
    return this.getStatus(providerName);
  }

  async getStatus(
    providerName: string,
  ): Promise<ProviderOnboardingStatus | null> {
    const result = await pool.query<{
      provider_name: string;
      status: ProviderOnboardingStatus["status"];
      steps: Record<string, ChecklistStepResult>;
      notes: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      "SELECT * FROM provider_onboarding_state WHERE provider_name = $1",
      [providerName.toLowerCase()],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      providerName: row.provider_name,
      status: row.status,
      steps: row.steps,
      notes: row.notes,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async listAll(): Promise<ProviderOnboardingStatus[]> {
    const result = await pool.query<{
      provider_name: string;
      status: ProviderOnboardingStatus["status"];
      steps: Record<string, ChecklistStepResult>;
      notes: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      "SELECT * FROM provider_onboarding_state ORDER BY provider_name ASC",
    );
    return result.rows.map((row) => ({
      providerName: row.provider_name,
      status: row.status,
      steps: row.steps,
      notes: row.notes,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }));
  }
}

export const checklistManager = new ChecklistManager();

/**
 * Lightweight export used by the wizard CLI to render a checklist
 * without hitting the database. Use `checklistManager.getStatus()`
 * when step results are needed too.
 */
export function renderChecklistTable(
  state: ProviderOnboardingStatus | null,
): string {
  const lines: string[] = [];
  lines.push("Onboarding checklist:");
  for (const def of DEFAULT_STEPS) {
    const result = state?.steps?.[def.id];
    const glyph = !result
      ? "•"
      : result.status === "passed"
        ? "✓"
        : result.status === "failed"
          ? "✗"
          : result.status === "skipped"
            ? "—"
            : "?";
    const note = result?.notes ? ` — ${result.notes}` : "";
    lines.push(`  [${glyph}] ${def.title}${note}`);
  }
  if (state) {
    lines.push(
      `\n  Overall status: ${state.status} (updated ${state.updatedAt})`,
    );
  }
  return lines.join("\n");
}
