module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.js', '**/*.test.js'],
  testPathIgnorePatterns: [
    '/node_modules/',
    'market-research/phase-tracker/phase-tracker\\.test\\.js$',
    'market-research/critical-failure-regression\\.test\\.js$',
    'market-research/tests/phase-tracker/runner\\.test\\.js$',
  ],
  collectCoverageFrom: ['**/*.js', '!**/node_modules/**', '!jest.config.js'],
  coverageDirectory: 'coverage',
  verbose: true,
};
