/**
 * Jest configuration for migration tests.
 *
 * Migration tests run against real PostgreSQL containers and apply
 * versioned schema fixtures representing historical database states,
 * then walk each migration chain to the expected current schema.
 */
module.exports = {
  displayName: 'migration',
  testEnvironment: 'node',
  roots: ['<rootDir>/test/migrations'],
  testMatch: ['**/*.migration.test.js'],
  testPathIgnorePatterns: ['/node_modules/'],
  // Migration chains are I/O bound (container startup + sequential DDL),
  // so allow generous timeouts and run serially to avoid container races.
  testTimeout: 120000,
  maxWorkers: 1,
  setupFilesAfterEnv: ['<rootDir>/test/migrations/setup.js'],
  globalSetup: '<rootDir>/test/migrations/globalSetup.js',
  globalTeardown: '<rootDir>/test/migrations/globalTeardown.js',
  collectCoverage: false,
  verbose: true,
};
