module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.js', '**/*.test.js'],
  // These suites use node:test or plain assert, so `npm run test:node` runs them.
  testPathIgnorePatterns: [
    '/node_modules/',
    '/market-research/phase-tracker/phase-tracker.test.js',
    '/market-research/tests/phase-tracker/runner.test.js',
    '/market-research/critical-failure-regression.test.js',
  ],
  collectCoverageFrom: [
    '**/*.js',
    '!**/node_modules/**',
    '!jest.config.js'
  ],
  coverageDirectory: 'coverage',
  verbose: true
};
