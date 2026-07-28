const autocannon = require("autocannon");
const fs = require("fs");
const path = require("path");

const BASELINE_DIR = path.join(__dirname, "..", "tests", "load", "baselines");
const RESULTS_DIR = path.join(__dirname, "..", "tests", "load", "results");

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadBaseline(): Record<string, any> | null {
  const baselinePath = path.join(BASELINE_DIR, "baseline.json");
  if (!fs.existsSync(baselinePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(baselinePath, "utf-8"));
}

function saveBaseline(data: Record<string, any>) {
  ensureDir(BASELINE_DIR);
  fs.writeFileSync(path.join(BASELINE_DIR, "baseline.json"), JSON.stringify(data, null, 2));
}

function saveResults(data: any[]) {
  ensureDir(RESULTS_DIR);
  const filename = `${Date.now()}_benchmark.json`;
  fs.writeFileSync(path.join(RESULTS_DIR, filename), JSON.stringify(data, null, 2));
}

async function runScenario(name: string, url: string, options: any = {}) {
  const result = await autocannon({
    url,
    connections: options.connections || 10,
    duration: options.duration || 10,
    ...options,
  });

  return {
    scenario: name,
    avgLatencyMs: result.latency.average,
    p95LatencyMs: result.latency.p95,
    requestsPerSecond: result.requests.average,
    errors: result.errors,
  };
}

async function main() {
  const baseUrl = process.env.BASE_URL || "http://localhost:3000";
  const scenarios = [
    { name: "health", path: "/health", connections: 50, duration: 10 },
    { name: "ready", path: "/ready", connections: 20, duration: 10 },
    { name: "transactions", path: "/api/transactions", connections: 10, duration: 10 },
  ];

  const results = [];
  for (const scenario of scenarios) {
    const result = await runScenario(scenario.name, `${baseUrl}${scenario.path}`, {
      connections: scenario.connections,
      duration: scenario.duration,
    });
    results.push(result);
  }

  saveResults(results);

  const baseline = loadBaseline();
  if (!baseline) {
    console.log("No baseline found. Saving current results as baseline.");
    saveBaseline({ timestamp: new Date().toISOString(), scenarios: results });
    process.exit(0);
  }

  console.log("\n=== Performance Regression Report ===");
  let regressions = 0;

  for (const result of results) {
    const prev = baseline.scenarios.find((s: any) => s.scenario === result.scenario);
    if (!prev) {
      console.log(`[${result.scenario}] No baseline — skipping`);
      continue;
    }

    const latencyIncrease =
      ((result.avgLatencyMs - prev.avgLatencyMs) / prev.avgLatencyMs) * 100;
    const throughputDecrease =
      ((prev.requestsPerSecond - result.requestsPerSecond) / prev.requestsPerSecond) * 100;

    console.log(`[${result.scenario}]`);
    console.log(`  Latency: ${result.avgLatencyMs.toFixed(2)}ms (${latencyIncrease > 0 ? "+" : ""}${latencyIncrease.toFixed(1)}%)`);
    console.log(`  Throughput: ${result.requestsPerSecond.toFixed(1)} req/s (${throughputDecrease > 0 ? "-" : ""}${throughputDecrease.toFixed(1)}%)`);

    if (latencyIncrease > 10 || throughputDecrease > 10) {
      console.log(`  ⚠️  REGRESSION DETECTED`);
      regressions++;
    } else {
      console.log(`  ✅ OK`);
    }
  }

  if (regressions > 0) {
    console.log(`\n❌ ${regressions} regression(s) detected. CI will fail.`);
    process.exit(1);
  } else {
    console.log("\n✅ No regressions detected.");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
