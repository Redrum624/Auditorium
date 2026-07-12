/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src'],
  transform: { '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: { jsx: 'react-jsx', module: 'commonjs', moduleResolution: 'node', esModuleInterop: true, strict: true } }] },
  moduleNameMapper: {
    '\\.(css)$': 'identity-obj-proxy',
    '^.+/createDspWorker$': '<rootDir>/src/__mocks__/createDspWorkerMock.ts',
    '^.+/createSpectrogramWorker$': '<rootDir>/src/__mocks__/createSpectrogramWorkerMock.ts'
  },
  setupFilesAfterEnv: ['<rootDir>/src/setupTests.ts']
};
