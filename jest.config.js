const fs = require("fs");
const path = require("path");

// Load quarantine registry to honour skipped flaky tests in normal CI.
// During flaky detection runs (JEST_RETRIES=0) we skip this to observe raw failure rates.
const QUARANTINE_PATH = path.join(__dirname, "tests/flaky/quarantine.json");
let quarantinedNames = [];
if (fs.existsSync(QUARANTINE_PATH)) {
  try {
    const reg = JSON.parse(fs.readFileSync(QUARANTINE_PATH, "utf8"));
    quarantinedNames = (reg.quarantined || []).map((q) => q.fullName);
  } catch {
    // malformed file — run all tests
  }
}

module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  setupFiles: ["<rootDir>/tests/jest.setup.ts"],
  roots: ["<rootDir>/src", "<rootDir>/tests"],
  testMatch: ["**/__tests__/**/*.ts", "**/?(*.)+(spec|test).ts"],
  testPathIgnorePatterns: ["/node_modules/", "/tests/pact/"],
  testTimeout: 30000,
  // Retry each failing test up to 2 times before marking as failed.
  // Set JEST_RETRIES=0 to disable (used by the flaky detector).
  retryTimes: process.env.JEST_RETRIES !== undefined
    ? parseInt(process.env.JEST_RETRIES, 10)
    : 2,
  moduleNameMapper: {
    "^(\\.\\.?\\/.+)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      { diagnostics: false },
    ],
  },
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.d.ts",
    "!src/index.ts",
    "!src/**/__tests__/**",
  ],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "text-summary", "lcov", "html", "json-summary"],
  coverageThreshold: {
    global: {
      branches: 75,
      functions: 75,
      lines: 75,
      statements: 75,
    },
  },
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
  verbose: true,
  maxWorkers: "50%",
  // Quarantine reporter appends a summary of quarantined tests after every run.
  reporters: [
    "default",
    "<rootDir>/tests/flaky/quarantine-reporter.ts",
  ],
};
