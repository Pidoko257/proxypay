const baseConfig = require("./jest.config");

/**
 * Jest config used exclusively by Stryker mutation testing.
 *
 * Only includes tests for the modules listed in stryker.conf.json `mutate` array.
 * Keeping the test scope narrow drastically reduces Stryker run time because
 * each mutant only re-runs the tests that cover the mutated file.
 *
 * When you add a new module to `stryker.conf.json mutate`, add its test here too.
 */
module.exports = {
  ...baseConfig,
  // Disable the quarantine reporter during mutation runs — it adds noise and
  // the quarantine registry is irrelevant for mutation analysis.
  reporters: ["default"],
  // No retries during mutation runs — we want to see the raw failure signal.
  retryTimes: 0,
  testMatch: [
    // Core services — existing
    "<rootDir>/tests/services/retry.test.ts",
    "<rootDir>/tests/services/fraud.test.ts",
    // Expanded critical modules
    "<rootDir>/tests/services/feeStrategyEngine.test.ts",
    "<rootDir>/tests/services/aml.test.ts",
    "<rootDir>/tests/services/layeredCache.test.ts",
    "<rootDir>/tests/services/currency.test.ts",
    "<rootDir>/tests/services/ledgerService.test.ts",
    "<rootDir>/tests/services/webhook.test.ts",
    "<rootDir>/tests/services/dispute.service.test.ts",
    // KYC
    "<rootDir>/tests/kyc.test.ts",
    // Auth
    "<rootDir>/tests/jwt.test.ts",
    // Transaction flows
    "<rootDir>/tests/transactions.test.ts",
  ],
};
