# P1-04 Evidence: engineering gates

- Status: PARTIAL / checkpoint. ESLint, core checkJs, and cross-platform CI definitions are complete; frontend and AutoPilot decomposition remain separate work.
- Changed: `.eslintrc.json`, `jsconfig.json`, `package.json`, `package-lock.json`, `.github/workflows/ci.yml`, `docs/SECURITY_NOTES.md`.
- Dependency gate: `eslint@8.57.1` MIT, `typescript@5.9.2` Apache-2.0, `@types/node@22.20.2` MIT; all dev-only.
- Verification: `npm ci --ignore-scripts` -> exit 0; `npm run lint` -> exit 0; `npm run check` -> exit 0.
- Full regression: `npm test` -> 1230 passed, 3 skipped, 1 pre-existing environment-sensitive failure in `lib/launch.test.js` (`probePort` timeout assertion).
- CI: `.github/workflows/ci.yml` defines Ubuntu/Windows Node 22 jobs running install, test, lint, and check.
- Remaining: split `public/app.js` and `lib/orchestrator/auto-loop.js`, add Electron E2E, and run CI on GitHub.
- Rollback: revert the P1-04 gate commit; application runtime behavior is unchanged.
