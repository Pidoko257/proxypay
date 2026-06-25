/**
 * Tests for scripts/deploy-escrow.sh
 *
 * The stellar/soroban CLI is stubbed via a fake binary placed first on $PATH.
 * Network calls never happen; we verify the script's logic: argument parsing,
 * .env persistence, upgrade path, smoke-test validation, and error handling.
 */

import { execSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const SCRIPT = path.resolve(__dirname, "../../scripts/deploy-escrow.sh");

const FAKE_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const FAKE_WASM_HASH   = "abc123def456abc123def456abc123def456abc123def456abc123def456abc1";

/** Create a temp dir with a stub `stellar` CLI and a pre-populated .env */
function setupWorkspace(opts: {
  smokeOutput?: string;
  deployFails?: boolean;
  existingContractId?: string;
  network?: string;
}): { dir: string; envFile: string; binDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-escrow-test-"));
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir);

  const smokeOutput = opts.smokeOutput ?? "error: not initialised";

  // Stub stellar binary — echoes deterministic output for each sub-command
  const stub = `#!/usr/bin/env bash
case "$1 $2" in
  "contract build")  exit 0 ;;
  "contract install") echo "${FAKE_WASM_HASH}" ;;
  "contract deploy")  echo "${FAKE_CONTRACT_ID}" ;;
  "contract invoke")  echo "${smokeOutput}" ; ${opts.deployFails ? "exit 1" : "exit 0"} ;;
  *) echo "stub: unknown command: $*" >&2; exit 1 ;;
esac
`;
  const stubPath = path.join(binDir, "stellar");
  fs.writeFileSync(stubPath, stub, { mode: 0o755 });

  // Minimal .env — WASM artifact must also exist
  const envFile = path.join(dir, ".env");
  const envLines = [`STELLAR_NETWORK=${opts.network ?? "testnet"}`];
  if (opts.existingContractId) {
    envLines.push(`ESCROW_CONTRACT_ID=${opts.existingContractId}`);
  }
  fs.writeFileSync(envFile, envLines.join("\n") + "\n");

  // Create fake WASM artifact so the "file not found" guard passes
  const wasmDir = path.join(
    dir,
    "contracts/target/wasm32-unknown-unknown/release",
  );
  fs.mkdirSync(wasmDir, { recursive: true });
  fs.writeFileSync(path.join(wasmDir, "escrow.wasm"), "fake");

  return { dir, envFile, binDir };
}

function runScript(
  workspaceDir: string,
  binDir: string,
  args: string[] = [],
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bash", [SCRIPT, ...args], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      STELLAR_DEPLOYER_SECRET: "STEST000000000000000000000000000000000000000000000000000000",
      STELLAR_RPC_URL: "http://localhost:9999",  // never reached
      // Override ROOT_DIR and CONTRACTS_DIR to use temp workspace
      // The script resolves paths from SCRIPT_DIR so we patch via symlink
    },
    cwd: workspaceDir,
    encoding: "utf8",
    timeout: 15000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

/** Re-run with ROOT_DIR pointed at the temp workspace via a copied script */
function runScriptInWorkspace(
  workspaceDir: string,
  binDir: string,
  args: string[] = [],
): { stdout: string; stderr: string; status: number } {
  // Copy script into the temp workspace's scripts/ dir so SCRIPT_DIR resolves correctly
  const scriptsDir = path.join(workspaceDir, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  const localScript = path.join(scriptsDir, "deploy-escrow.sh");
  let scriptContent = fs.readFileSync(SCRIPT, "utf8");
  // Patch contracts dir build command to skip the real cargo invocation
  scriptContent = scriptContent.replace(
    '(cd "$CONTRACTS_DIR" && "$CLI" contract build)',
    'echo "[stub] contract build skipped"',
  );
  fs.writeFileSync(localScript, scriptContent, { mode: 0o755 });

  const result = spawnSync("bash", [localScript, ...args], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      STELLAR_DEPLOYER_SECRET: "STEST000000000000000000000000000000000000000000000000000000",
      STELLAR_RPC_URL: "http://localhost:9999",
    },
    cwd: workspaceDir,
    encoding: "utf8",
    timeout: 15000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("deploy-escrow.sh", () => {
  it("fails with exit 1 when STELLAR_DEPLOYER_SECRET is not set", () => {
    const { dir, binDir } = setupWorkspace({});
    const result = spawnSync("bash", [SCRIPT], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, STELLAR_DEPLOYER_SECRET: "" },
      cwd: dir,
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/STELLAR_DEPLOYER_SECRET/);
  });

  it("fails with exit 1 for an invalid --network value", () => {
    const { dir, binDir } = setupWorkspace({});
    const result = spawnSync("bash", [SCRIPT, "--network=fakenet"], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        STELLAR_DEPLOYER_SECRET: "STEST000000000000000000000000000000000000000000000000000000",
      },
      cwd: dir,
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/Invalid.*network/i);
  });

  it("completes a fresh deploy, saves contract ID and wasm hash to .env", () => {
    const { dir, binDir, envFile } = setupWorkspace({
      smokeOutput: "error: not initialised",
    });
    const result = runScriptInWorkspace(dir, binDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Deployment complete/i);
    expect(result.stdout).toContain(FAKE_CONTRACT_ID);

    const env = fs.readFileSync(envFile, "utf8");
    expect(env).toMatch(new RegExp(`ESCROW_CONTRACT_ID=${FAKE_CONTRACT_ID}`));
    expect(env).toMatch(new RegExp(`ESCROW_WASM_HASH=${FAKE_WASM_HASH}`));
  });

  it("persists STELLAR_NETWORK to .env", () => {
    const { dir, binDir, envFile } = setupWorkspace({ network: "testnet" });
    const result = runScriptInWorkspace(dir, binDir, ["--network=testnet"]);

    expect(result.status).toBe(0);
    const env = fs.readFileSync(envFile, "utf8");
    expect(env).toMatch(/STELLAR_NETWORK=testnet/);
  });

  it("smoke test passes when response contains 'error' (uninitialised contract)", () => {
    const { dir, binDir } = setupWorkspace({
      smokeOutput: "HostError: error: not initialised",
    });
    const result = runScriptInWorkspace(dir, binDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Smoke test passed/i);
  });

  it("smoke test passes when response contains contract state fields", () => {
    const { dir, binDir } = setupWorkspace({
      smokeOutput: '{"depositor":"G...","beneficiary":"G...","released":false}',
    });
    const result = runScriptInWorkspace(dir, binDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Smoke test passed/i);
  });

  it("performs upgrade (invokes upgrade fn) when --upgrade and ESCROW_CONTRACT_ID are set", () => {
    const existingId = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4";
    const { dir, binDir, envFile } = setupWorkspace({
      existingContractId: existingId,
      smokeOutput: "error: not initialised",
    });

    const result = runScriptInWorkspace(dir, binDir, ["--upgrade"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Upgrading existing contract/i);
    // Contract ID must remain the existing one, not a newly deployed one
    const env = fs.readFileSync(envFile, "utf8");
    expect(env).toMatch(new RegExp(`ESCROW_CONTRACT_ID=${existingId}`));
  });

  it("updates existing ESCROW_CONTRACT_ID line rather than appending a duplicate", () => {
    const { dir, binDir, envFile } = setupWorkspace({
      smokeOutput: "error: not initialised",
    });
    // Pre-populate .env with an old contract ID
    fs.appendFileSync(envFile, "ESCROW_CONTRACT_ID=COLD_ID\n");

    runScriptInWorkspace(dir, binDir);

    const env = fs.readFileSync(envFile, "utf8");
    const matches = env.match(/ESCROW_CONTRACT_ID=/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(env).toMatch(new RegExp(`ESCROW_CONTRACT_ID=${FAKE_CONTRACT_ID}`));
  });
});
