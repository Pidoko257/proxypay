/**
 * Jest Custom Reporter — Quarantine Summary
 *
 * Prints a quarantine summary after every Jest run so developers are always
 * aware of tests currently disabled due to flakiness.
 *
 * Add to jest.config.js reporters array:
 *   reporters: ['default', '<rootDir>/tests/flaky/quarantine-reporter.ts']
 */

import * as fs from 'fs';
import * as path from 'path';

const QUARANTINE_PATH = path.join(__dirname, 'quarantine.json');

interface QuarantineEntry {
  testName: string;
  fullName: string;
  flakyScore: number;
  firstSeen: string;
  status: string;
}

interface QuarantineRegistry {
  quarantined: QuarantineEntry[];
  resolved: QuarantineEntry[];
}

interface JestTestResult {
  fullName: string;
  status: string;
}

interface JestSuiteResult {
  testResults: JestTestResult[];
  testFilePath: string;
}

interface AggregatedResult {
  testResults: JestSuiteResult[];
}

export default class QuarantineReporter {
  private registry: QuarantineRegistry = { quarantined: [], resolved: [] };

  constructor() {
    if (fs.existsSync(QUARANTINE_PATH)) {
      try {
        this.registry = JSON.parse(fs.readFileSync(QUARANTINE_PATH, 'utf8'));
      } catch {
        this.registry = { quarantined: [], resolved: [] };
      }
    }
  }

  onRunComplete(_contexts: unknown, results: AggregatedResult): void {
    const count = this.registry.quarantined.length;
    if (count === 0) return;

    // Warn if any quarantined test ran (should be skipped)
    const quarantinedNames = new Set(this.registry.quarantined.map((q) => q.fullName));
    const ranAnyway: Array<{ fullName: string; status: string; file: string }> = [];

    for (const suite of results.testResults ?? []) {
      for (const t of suite.testResults ?? []) {
        if (quarantinedNames.has(t.fullName)) {
          ranAnyway.push({ fullName: t.fullName, status: t.status, file: suite.testFilePath });
        }
      }
    }

    console.log('\n══════════════════════════════════════════════');
    console.log('  🔒 QUARANTINE REPORT');
    console.log('══════════════════════════════════════════════');
    console.log(`  Quarantined : ${count} test(s)`);

    if (ranAnyway.length > 0) {
      console.log(`\n  ⚠️  ${ranAnyway.length} quarantined test(s) ran without .skip:`);
      for (const t of ranAnyway) {
        console.log(`    ${t.status === 'failed' ? '❌' : '✅'} [${t.status}] ${t.fullName}`);
      }
    }

    console.log('\n  Currently quarantined:');
    for (const q of this.registry.quarantined) {
      console.log(`    • [score: ${q.flakyScore}] ${q.testName} (since ${q.firstSeen.slice(0, 10)})`);
    }
    console.log('\n  See tests/flaky/dashboard.md for resolution steps.');
    console.log('══════════════════════════════════════════════\n');
  }
}
