/** @type {import('jest').Config} */
module.exports = {
  projects: [
    {
      displayName: 'renderer',
      testEnvironment: 'jsdom',
      roots: ['<rootDir>/src'],
      transform: {
        '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: { jsx: 'react-jsx', module: 'commonjs', moduleResolution: 'node', esModuleInterop: true, strict: true } }],
        // @breezystack/lamejs ships a broken CommonJS ("require") target — only its
        // ESM build exports Mp3Encoder. We map the import to that ESM file (below)
        // and transform its `export` syntax to CommonJS via ts-jest with allowJs.
        '^.+\\.js$': ['ts-jest', { tsconfig: { allowJs: true, module: 'commonjs', moduleResolution: 'node', esModuleInterop: true } }]
      },
      // Ignore all of node_modules EXCEPT lamejs, which must be transformed.
      transformIgnorePatterns: ['/node_modules/(?!@breezystack/lamejs/)'],
      moduleNameMapper: {
        '\\.(css)$': 'identity-obj-proxy',
        '^@breezystack/lamejs$': '<rootDir>/node_modules/@breezystack/lamejs/dist/lamejs.js',
        '^.+/createDspWorker$': '<rootDir>/src/__mocks__/createDspWorkerMock.ts',
        '^.+/createSpectrogramWorker$': '<rootDir>/src/__mocks__/createSpectrogramWorkerMock.ts',
        '^.+/createTempoWorker$': '<rootDir>/src/__mocks__/createTempoWorkerMock.ts'
      },
      setupFilesAfterEnv: ['<rootDir>/src/setupTests.ts']
    },
    {
      displayName: 'main',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/electron/**/*.test.cjs']
    },
    {
      displayName: 'scripts',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/scripts/**/*.test.cjs']
    }
  ]
};
