# Contributing

Thanks for your interest in Auditorium! Before a PR:

1. Open an issue describing the change you have in mind.
2. One logical change per PR; follow the existing code style (TypeScript strict,
   the surrounding file's comment voice, no drive-by refactors).
3. Run the test suite — PRs must be green:

   ```bash
   npm test              # full unit suite (3 jest projects)
   npm run typecheck     # tsc --noEmit
   ```

4. Behavior changes need tests that fail before the change and pass after.
   Constants derived from measurements keep their derivation suites — see
   `docs/bench/README.md` for the measurement discipline this project follows.
5. For anything touching the packaged app (main process, build, installers),
   note in the PR how you verified it against a built artifact, not only the
   dev server.
