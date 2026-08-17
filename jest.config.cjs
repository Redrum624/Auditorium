/**
 * M2: agent worktrees live under `.claude/worktrees/<id>/`, each a FULL checkout
 * of this repo with a `node_modules` symlink back to this one. The `main` and
 * `scripts` projects set no `roots`, so their haste map crawls from `<rootDir>`
 * and swallowed those copies whole — every `package.json` and every `__mocks__`
 * directory twice or three times over, which is the naming-collision warning
 * this project has been printing all evening, plus the crawl cost of N repos.
 *
 * Written separator-agnostically and WITHOUT `<rootDir>`: Jest substitutes
 * `<rootDir>` as a literal into a string that is then compiled as a regex, and
 * on Windows that literal is `D:\Dev\...` — backslashes the regex engine reads
 * as escapes. Matching the path SEGMENT instead works on both platforms, and
 * `.claude` is unambiguous here: it is gitignored and appears nowhere else.
 *
 * MT1: the pattern matches on ABSOLUTE paths, so when jest is run FROM inside an
 * agent worktree every test path contains `.claude` and the suite silently
 * collapses to zero tests — `jest --listTests` printed nothing and exited 0.
 * A worktree ignoring itself is never the intent: the rule exists to stop the
 * MAIN checkout crawling its siblings. So it only arms when this config is NOT
 * itself inside a worktree, which is exactly the case it was written for.
 */
const INSIDE_AGENT_WORKTREE = /[/\\]\.claude[/\\]worktrees[/\\]/.test(__dirname);
const IGNORE_AGENT_WORKTREES = INSIDE_AGENT_WORKTREE ? [] : ['[/\\\\]\\.claude[/\\\\]'];

/** Jest's `testPathIgnorePatterns` DEFAULT is `['/node_modules/']`; setting the
 * key replaces it rather than extending it, so the default is restated here. */
const TEST_PATH_IGNORE = ['/node_modules/', ...IGNORE_AGENT_WORKTREES];

/** @type {import('jest').Config} */
module.exports = {
  projects: [
    {
      displayName: 'renderer',
      modulePathIgnorePatterns: IGNORE_AGENT_WORKTREES,
      testPathIgnorePatterns: TEST_PATH_IGNORE,
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
        '^.+/createTempoWorker$': '<rootDir>/src/__mocks__/createTempoWorkerMock.ts',
        '^.+/createRemixPlanWorker$': '<rootDir>/src/__mocks__/createRemixPlanWorkerMock.ts',
        '^.+/createWavDecodeWorker$': '<rootDir>/src/__mocks__/createWavDecodeWorkerMock.ts'
      },
      setupFilesAfterEnv: ['<rootDir>/src/setupTests.ts']
    },
    // MT1 fix round: `roots` + a ROOT-RELATIVE `testMatch`, which is what
    // `renderer` above already does and what these two must do for the same
    // reason the ignore pattern needed rewriting.
    //
    // `<rootDir>` is substituted as a LITERAL into a glob, and from a worktree
    // that literal is `D:\Dev\...\.claude\worktrees\<id>\electron\**\*.test.cjs`.
    // `jest-util`'s path normaliser converts `\` to `/` EXCEPT before a
    // glob-special character, so the backslash in `\.claude` survives and
    // escapes the dot — the pattern then matches nothing and the project
    // discovers ZERO tests while still exiting 0. Exactly the defect class the
    // M2 docblock above records for the regex, in the glob this time: `main`
    // and `scripts` silently ran nothing from every agent worktree, so a
    // worktree's "full suite green" was only ever the renderer project.
    //
    // `roots` is not a glob — it is a path Jest resolves and crawls — so it
    // carries no escaping hazard, and a `**/*.test.cjs` pattern with no
    // absolute prefix has nothing to escape.
    {
      displayName: 'main',
      testEnvironment: 'node',
      modulePathIgnorePatterns: IGNORE_AGENT_WORKTREES,
      testPathIgnorePatterns: TEST_PATH_IGNORE,
      roots: ['<rootDir>/electron'],
      testMatch: ['**/*.test.cjs']
    },
    {
      displayName: 'scripts',
      testEnvironment: 'node',
      modulePathIgnorePatterns: IGNORE_AGENT_WORKTREES,
      testPathIgnorePatterns: TEST_PATH_IGNORE,
      roots: ['<rootDir>/scripts'],
      testMatch: ['**/*.test.cjs']
    }
  ]
};
