/** Jest config for the MCP server adapter (stdio MCP <-> the app's local pipe). */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: __dirname,
  roots: ['<rootDir>/src'],
  transform: {
    '^.+\\.ts$':['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
  moduleNameMapper: {
    '^@motion/ai-tools$': '<rootDir>/../ai-tools/src/index.ts',
    '^@motion/engine-api$': '<rootDir>/../engine-api/src/index.ts',
  },
  testMatch: ['**/*.test.ts'],
};
