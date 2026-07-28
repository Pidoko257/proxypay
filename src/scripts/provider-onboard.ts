#!/usr/bin/env tsx
/**
 * Provider Onboarding Wizard (CLI)
 *
 * Issue #187 — Provider Onboarding Workflow, acceptance criterion #2.
 *
 * Single CLI entrypoint for the entire onboarding workflow. The
 * underlying modules are also usable programmatically — the wizard is
 * just an orchestrator + a splash of ANSI colours.
 *
 * Sub-commands:
 *   list                                — show every adapter with status
 *   init <name>                         — emit adapter boilerplate
 *   creds <name> [--api-key … …]        — encrypt + store credentials
 *   health <name> --url …               — register health check
 *   sandbox <name>                      — run sandbox E2E test runner
 *   status <name>                       — print checklist state
 *   evaluate <name>                     — re-run all auto checklist steps
 *   demo <name>                         — health + sandbox + evaluate
 *
 * Every sub-command exits 0 on success, 1 on validation failure.
 */

import fs from "fs";
import path from "path";
import {
  generateAdapterBoilerplate,
  listBuiltinAdapters,
  validateAdapter,
  credentialManager,
  describeCapabilities,
  checklistManager,
  renderChecklistTable,
  DEFAULT_STEPS,
  healthCheckSetup,
  runSandboxTests,
  recordSandboxReport,
} from "../providerOnboarding";
import type {
  ProviderAuthMode,
  ProviderCredentialPayload,
} from "../providerOnboarding";

const isTest = process.env.NODE_ENV === "test";
const c = {
  reset: isTest ? "" : "\x1b[0m",
  bold: isTest ? "" : "\x1b[1m",
  dim: isTest ? "" : "\x1b[2m",
  green: isTest ? "" : "\x1b[32m",
  yellow: isTest ? "" : "\x1b[33m",
  red: isTest ? "" : "\x1b[31m",
  cyan: isTest ? "" : "\x1b[36m",
  gray: isTest ? "" : "\x1b[90m",
};

const log = {
  info: (msg: string) => console.log(`${c.cyan}${msg}${c.reset}`),
  ok: (msg: string) => console.log(`${c.green}✓ ${msg}${c.reset}`),
  warn: (msg: string) => console.log(`${c.yellow}! ${msg}${c.reset}`),
  err: (msg: string) => console.log(`${c.red}✗ ${msg}${c.reset}`),
  dim: (msg: string) => console.log(`${c.dim}${msg}${c.reset}`),
};

interface ParsedArgs {
  flags: Record<string, string>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq > 0) flags[token.slice(2, eq)] = token.slice(eq + 1);
      else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else flags[key] = "true";
      }
    } else positional.push(token);
  }
  return { flags, positional };
}

function usage(): void {
  console.log(`${c.bold}${c.cyan}Provider Onboarding Wizard${c.reset}
${c.dim}==============================================${c.reset}

Sub-commands:
  ${c.green}list${c.reset}
      List every registered provider along with onboarding status.

  ${c.green}init <name>${c.reset}
      Emit a boilerplate adapter to
      src/services/mobilemoney/providers/<name>.adapter.ts.

  ${c.green}creds <name>${c.reset}
      Encrypt + store credentials. Required fields depend on the
      adapter's declared authMode.
      Flags: --api-key <k> --api-secret <s> --subscription-key <sk>
             --client-id <id> --client-secret <secret>
             --username <u> --password <p>
             --callback-secret <s> --extras <json>
             --auth-mode <direct|web|proxy|api_key|oauth>

  ${c.green}health <name>${c.reset}
      Insert/update a row in provider_health_configs. Flags:
        --url <https://…>          (required)
        --timeout-ms <ms>          (default 5000)

  ${c.green}sandbox <name>${c.reset}
      Run the in-process sandbox E2E runner and persist the result so
      the next \`evaluate\` run picks it up.

  ${c.green}status <name>${c.reset}
      Pretty-print the per-step checklist for <name>.

  ${c.green}evaluate <name>${c.reset}
      Re-evaluate every checklist step and update the
      provider_onboarding_state row.

  ${c.green}demo <name>${c.reset}
      End-to-end onboarding for a credentialed provider:
      health ⇒ sandbox ⇒ evaluate.

Examples:
  npm run provider:onboard -- list
  npm run provider:onboard -- init vodacom
  npm run provider:onboard -- creds vodacom --api-key xxx --api-secret yyy
  npm run provider:onboard -- health vodacom --url https://api.vodacom.example/health
  npm run provider:onboard -- sandbox vodacom
  npm run provider:onboard -- evaluate vodacom
  npm run provider:onboard -- demo vodacom
`);
}

function requireName(name: string | undefined): string {
  if (!name) {
    log.err("Missing provider-name argument.");
    process.exitCode = 1;
    usage();
    throw new Error("missing-provider-name");
  }
  return name.toLowerCase();
}

function flagExact(argv: ParsedArgs, key: string): string | undefined {
  const v = argv.flags[key];
  if (v === undefined || v === "true") return undefined;
  return v;
}

// ─── Sub-commands ─────────────────────────────────────────────────────────

async function cmdList(): Promise<void> {
  const adapters = listBuiltinAdapters();
  if (adapters.length === 0) {
    log.warn("No adapters registered (this should not happen — check builtinAdapters.ts).");
    return;
  }
  log.info("Registered providers:");
  const states = await checklistManager.listAll();
  const stateByName = new Map(states.map((s) => [s.providerName, s]));
  for (const a of adapters) {
    const desc = describeCapabilities(a.name) ?? a.displayName;
    log.dim(`  • ${desc}`);
    const state = stateByName.get(a.name);
    if (state) {
      log.dim(
        `      state=${state.status}, steps=${Object.values(state.steps).filter((r) => r.status === "passed").length}/${DEFAULT_STEPS.length} passed`,
      );
    } else {
      log.dim(`      state=not_started`);
    }
  }

  const creds = await credentialManager.listCredentials();
  if (creds.length > 0) {
    log.info("\nStored credentials:");
    for (const row of creds) {
      log.dim(
        `  • ${row.providerName} [${row.authMode}] rotated=${row.lastRotatedAt} age=${row.ageInDays}d ` +
          `key=${row.hasApiKey} secret=${row.hasApiSecret} subKey=${row.hasSubscriptionKey} callback=${row.hasCallbackSecret}`,
      );
    }
  }
}

async function cmdInit(name: string): Promise<void> {
  const boilerplate = generateAdapterBoilerplate(name);
  const targetPath = path.resolve(
    process.cwd(),
    "src",
    "services",
    "mobilemoney",
    "providers",
    `${name}.adapter.ts`,
  );
  if (fs.existsSync(targetPath)) {
    log.warn(`Refusing to overwrite ${targetPath}`);
    return;
  }
  fs.writeFileSync(targetPath, boilerplate, "utf-8");
  log.ok(`Wrote adapter boilerplate to ${c.cyan}${targetPath}${c.reset}`);
  log.dim("Next: edit the file (endpoints + capabilities), then run");
  log.dim(`  npm run provider:onboard -- creds ${name} --api-key …`);
  log.dim(`  npm run provider:onboard -- health ${name} --url …`);
  log.dim(`  npm run provider:onboard -- sandbox ${name}`);
}

async function cmdCreds(name: string, argv: ParsedArgs): Promise<void> {
  const adapter = listBuiltinAdapters().find((a) => a.name === name);
  if (!adapter) {
    log.warn(
      `No builtin adapter named "${name}". Run \`init ${name}\` first, or add the adapter to builtinAdapters.ts.`,
    );
  }

  const authMode = (flagExact(argv, "auth-mode") ??
    adapter?.getCapabilities().authMode ??
    "direct") as ProviderAuthMode;

  const payload: ProviderCredentialPayload = {
    apiKey: flagExact(argv, "api-key"),
    apiSecret: flagExact(argv, "api-secret"),
    subscriptionKey: flagExact(argv, "subscription-key"),
    clientId: flagExact(argv, "client-id"),
    clientSecret: flagExact(argv, "client-secret"),
    username: flagExact(argv, "username"),
    password: flagExact(argv, "password"),
    callbackSecret: flagExact(argv, "callback-secret"),
  };

  const extrasRaw = flagExact(argv, "extras");
  if (extrasRaw) {
    try {
      payload.extras = JSON.parse(extrasRaw) as Record<string, string>;
    } catch (err) {
      log.err(`Invalid JSON in --extras: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }

  if (adapter) {
    try {
      validateAdapter(adapter);
    } catch (err) {
      log.err(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
    const required = adapter.getRequiredCredentialFields();
    for (const field of required) {
      if (!payload[field]) {
        log.err(
          `Adapter "${name}" requires --${kebab(String(field))} (authMode=${authMode}).`,
        );
        process.exitCode = 1;
        return;
      }
    }
  }

  await credentialManager.upsertCredentials(name, authMode, payload);
  log.ok(`Stored credentials for "${name}" (authMode=${authMode}).`);
  log.dim(`  ${c.gray}Note: payloads are AES-256-GCM encrypted at rest.${c.reset}`);
  await checklistManager.markStep(
    name,
    "credentials_issued",
    "passed",
    `authMode=${authMode}, rotated ${new Date().toISOString()}`,
  );
}

async function cmdHealth(name: string, argv: ParsedArgs): Promise<void> {
  const url = flagExact(argv, "url");
  if (!url) {
    log.err("Missing required --url.");
    process.exitCode = 1;
    return;
  }
  const timeoutMs = Number(flagExact(argv, "timeout-ms") ?? "5000");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) {
    log.err("--timeout-ms must be between 1 and 60000.");
    process.exitCode = 1;
    return;
  }
  const row = await healthCheckSetup.registerProviderForHealthCheck({
    providerName: name,
    pingUrl: url,
    timeoutMs,
  });
  log.ok(
    `Registered health check for "${name}" (pingUrl=${row.pingUrl}, timeoutMs=${row.timeoutMs}).`,
  );
  await checklistManager.markStep(
    name,
    "health_check_registered",
    "passed",
    `${row.pingUrl} (timeoutMs=${row.timeoutMs})`,
  );
}

async function cmdSandbox(name: string): Promise<void> {
  // Force the in-process mock path so the wizard runs in CI without
  // external network. Operators can still override by clearing this var.
  const previousEnv = process.env.IS_SANDBOX;
  process.env.IS_SANDBOX = "true";
  try {
    const report = await runSandboxTests(name, { allowExternalNetwork: false });
    log.info(`Sandbox report for "${name}" (${report.environment}):`);
    for (const r of report.results) {
      log.dim(
        `  ${r.success ? "✓" : "✗"} ${r.operation.padEnd(11)} ${r.responseTimeMs}ms ${r.notes ?? r.error ?? ""}`,
      );
    }
    log.ok(`Sandbox summary: ${report.summary}`);
    await recordSandboxReport(report);
  } finally {
    if (previousEnv === undefined) delete process.env.IS_SANDBOX;
    else process.env.IS_SANDBOX = previousEnv;
  }
}

async function cmdStatus(name: string): Promise<void> {
  const status = await checklistManager.getStatus(name);
  if (!status) {
    log.warn(`No onboarding state recorded for "${name}".`);
    return;
  }
  log.info(`Onboarding status for "${name}": ${status.status}`);
  console.log(renderChecklistTable(status));
}

async function cmdEvaluate(name: string): Promise<void> {
  const status = await checklistManager.evaluateAll(name);
  log.info(`Evaluated checklist for "${name}": ${status.status}`);
  console.log(renderChecklistTable(status));
  if (status.status !== "ready") {
    log.warn("Not all steps passed — provider is NOT ready for production traffic yet.");
  }
}

async function cmdDemo(name: string, argv: ParsedArgs): Promise<void> {
  log.info(`Running end-to-end onboarding demo for "${name}"…`);
  await cmdHealth(name, argv);
  await cmdSandbox(name);
  await cmdEvaluate(name);
  const status = await checklistManager.getStatus(name);
  log.info(
    status?.status === "ready"
      ? `${c.bold}${c.green}"${name}" is READY for production traffic.${c.reset}`
      : `${c.yellow}"${name}" is ${status?.status ?? "unknown"} — see checklist above.${c.reset}`,
  );
}

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}

// ─── Entrypoint ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = parseArgs(process.argv.slice(2));
  const [command, ...rest] = argv.positional;

  if (!command || command === "--help" || command === "-h") {
    usage();
    return;
  }

  try {
    switch (command) {
      case "list":
        await cmdList();
        break;
      case "init":
        await cmdInit(requireName(rest[0]));
        break;
      case "creds":
        await cmdCreds(requireName(rest[0]), argv);
        break;
      case "health":
        await cmdHealth(requireName(rest[0]), argv);
        break;
      case "sandbox":
        await cmdSandbox(requireName(rest[0]));
        break;
      case "status":
        await cmdStatus(requireName(rest[0]));
        break;
      case "evaluate":
        await cmdEvaluate(requireName(rest[0]));
        break;
      case "demo":
        await cmdDemo(requireName(rest[0]), argv);
        break;
      default:
        log.err(`Unknown command "${command}".`);
        usage();
        process.exitCode = 1;
    }
  } catch (err) {
    if ((err as Error).message === "missing-provider-name") return;
    log.err((err as Error).message);
    process.exitCode = 1;
  }
}

// Exported for testability so jest can drive without spawning a process.
export const __test__ = {
  cmdList,
  cmdInit,
  cmdCreds,
  cmdHealth,
  cmdSandbox,
  cmdStatus,
  cmdEvaluate,
  cmdDemo,
  parseArgs,
};

if (require.main === module) {
  main().catch((err) => {
    log.err(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
