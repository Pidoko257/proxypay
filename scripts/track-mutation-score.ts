/**
 * Mutation Score Tracker
 *
 * Reads the Stryker JSON report and appends the score to a history file
 * so mutation scores can be tracked over time.
 *
 * Usage:
 *   npx tsx scripts/track-mutation-score.ts
 *   npx tsx scripts/track-mutation-score.ts --threshold=80
 *   npx tsx scripts/track-mutation-score.ts --report=reports/mutation/mutation.json
 *
 * Exits with code 1 if the score is below the threshold (for CI gate).
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface MutationHistoryEntry {
  date: string;
  score: number;
  killed: number;
  survived: number;
  timeout: number;
  noCoverage: number;
  total: number;
  branch: string;
  commit: string;
}

interface MutationHistory {
  threshold: number;
  entries: MutationHistoryEntry[];
}

// ---------------------------------------------------------------------------
// Paths & config
// ---------------------------------------------------------------------------
const ROOT           = path.resolve(__dirname, '..');
const REPORT_PATH    = path.join(ROOT, 'reports', 'mutation', 'mutation.json');
const HISTORY_PATH   = path.join(ROOT, 'reports', 'mutation', 'score-history.json');
const DASHBOARD_PATH = path.join(ROOT, 'reports', 'mutation', 'MUTATION_DASHBOARD.md');

function parseArgs(): { threshold: number; reportPath: string } {
  const args = process.argv.slice(2);
  let threshold = 80;
  let reportPath = REPORT_PATH;
  for (const a of args) {
    if (a.startsWith('--threshold=')) threshold = parseInt(a.split('=')[1], 10);
    if (a.startsWith('--report=')) reportPath = path.resolve(ROOT, a.split('=')[1]);
  }
  return { threshold, reportPath };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main(): void {
  const { threshold, reportPath } = parseArgs();

  if (!fs.existsSync(reportPath)) {
    console.error(`❌ Mutation report not found: ${reportPath}`);
    console.error('   Run `npm run test:mutation` first.');
    process.exit(1);
  }

  // Parse Stryker JSON report
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

  // Stryker JSON report structure varies by version; handle both shapes
  const files: Record<string, { mutants: Array<{ status: string }> }> =
    report.files || {};

  let killed = 0, survived = 0, timeout = 0, noCoverage = 0, total = 0;

  for (const file of Object.values(files)) {
    for (const mutant of file.mutants || []) {
      total++;
      switch (mutant.status) {
        case 'Killed':     killed++;     break;
        case 'Survived':   survived++;   break;
        case 'Timeout':    timeout++;    break;
        case 'NoCoverage': noCoverage++; break;
      }
    }
  }

  // Also try top-level mutationScore field (older Stryker versions)
  const score: number = report.mutationScore !== undefined
    ? parseFloat(report.mutationScore)
    : total > 0
      ? parseFloat(((killed / (total - noCoverage - timeout)) * 100).toFixed(2))
      : 0;

  // Load or initialise history
  const historyDir = path.dirname(HISTORY_PATH);
  if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir, { recursive: true });

  const history: MutationHistory = fs.existsSync(HISTORY_PATH)
    ? JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'))
    : { threshold, entries: [] };

  const entry: MutationHistoryEntry = {
    date:       new Date().toISOString(),
    score,
    killed,
    survived,
    timeout,
    noCoverage,
    total,
    branch:     process.env.GITHUB_REF_NAME || process.env.BRANCH || 'local',
    commit:     (process.env.GITHUB_SHA || '').slice(0, 8) || 'local',
  };

  history.entries.push(entry);

  // Keep last 100 entries
  if (history.entries.length > 100) {
    history.entries = history.entries.slice(-100);
  }

  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));

  // Update dashboard
  updateDashboard(history, threshold);

  // Console output
  const pass = score >= threshold;
  console.log('\n══════════════════════════════════════════════════');
  console.log('  Mutation Score Report');
  console.log('══════════════════════════════════════════════════');
  console.log(`  Score      : ${score.toFixed(2)}%  (threshold: ${threshold}%)`);
  console.log(`  Total      : ${total}`);
  console.log(`  Killed     : ${killed}`);
  console.log(`  Survived   : ${survived}`);
  console.log(`  Timeout    : ${timeout}`);
  console.log(`  NoCoverage : ${noCoverage}`);
  console.log(`  Result     : ${pass ? '✅ PASS' : '❌ FAIL'}`);
  console.log('══════════════════════════════════════════════════\n');
  console.log(`History → ${HISTORY_PATH}`);
  console.log(`Dashboard → ${DASHBOARD_PATH}`);

  if (!pass) {
    console.error(`\n❌ Mutation score ${score.toFixed(2)}% is below threshold ${threshold}%.`);
    console.error('   Review survived mutants in reports/mutation/html/index.html');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
function updateDashboard(history: MutationHistory, threshold: number): void {
  const last = history.entries[history.entries.length - 1];
  const prev = history.entries.length > 1
    ? history.entries[history.entries.length - 2]
    : null;

  const trend = prev
    ? last.score > prev.score ? '📈' : last.score < prev.score ? '📉' : '➡️'
    : '—';

  const rows = history.entries
    .slice(-20)
    .reverse()
    .map((e) =>
      `| ${e.date.slice(0, 10)} | ${e.score.toFixed(2)}% | ${e.killed} | ${e.survived} | ${e.noCoverage} | ${e.branch} | ${e.commit} |`,
    )
    .join('\n');

  const md = `# 🧬 Mutation Testing Dashboard

> Generated by \`scripts/track-mutation-score.ts\`
> Last updated: ${new Date().toISOString()}

## Current Score

| Metric | Value |
|--------|-------|
| Mutation Score | **${last.score.toFixed(2)}%** ${trend} |
| Threshold | ${threshold}% |
| Status | ${last.score >= threshold ? '✅ PASS' : '❌ FAIL'} |
| Killed | ${last.killed} |
| Survived | ${last.survived} |
| No Coverage | ${last.noCoverage} |
| Total Mutants | ${last.total} |
| Last Run | ${last.date.slice(0, 19).replace('T', ' ')} |
| Branch | ${last.branch} |

## Score History (last 20 runs)

| Date | Score | Killed | Survived | No Coverage | Branch | Commit |
|------|-------|--------|----------|-------------|--------|--------|
${rows}

## What is Mutation Testing?

Stryker introduces small code changes ("mutants") — like changing \`>\` to \`>=\`,
negating a condition, or removing a return value — then runs your tests against
each mutant. If a test fails, the mutant is **killed** (good). If all tests pass,
the mutant **survived** (weak test).

## Score Meaning

| Score | Meaning |
|-------|---------|
| > 80% | Strong test suite |
| 70–80% | Acceptable — improve coverage |
| < 70% | Weak tests — CI gate fails |

## Modules Under Mutation

Configured in \`stryker.conf.json\` \`mutate\` array:
- \`src/services/retry.ts\`
- \`src/services/fraud.ts\`
- \`src/services/feeStrategyEngine.ts\`
- \`src/services/transactionService.ts\`
- \`src/services/kyc.ts\`
- \`src/services/aml.ts\`
- \`src/services/layeredCache.ts\`
- \`src/services/currency.ts\`
- \`src/services/ledgerService.ts\`
- \`src/services/webhook.ts\`
- \`src/services/dispute.ts\`
- \`src/services/disputeStateMachine.ts\`

## How to Improve the Score

1. Run \`npm run test:mutation\` locally
2. Open \`reports/mutation/html/index.html\` in your browser
3. Find survived mutants (highlighted in red)
4. Add or strengthen assertions to kill them
5. Re-run until score is above ${threshold}%

## HTML Report

\`reports/mutation/html/index.html\` — open locally or download from CI artifacts.
`;

  fs.writeFileSync(DASHBOARD_PATH, md);
}

main();
