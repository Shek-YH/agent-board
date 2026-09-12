# P0-01 Evidence: watcher Range Read

- Goal: replace whole-file tail reads with bounded byte-range reads.
- Changed: `lib/watcher.js`, `lib/watcher.test.js`, `tools/benchmark-watcher.js`.
- Focused test: `node --test lib/watcher.test.js` -> 3 passed.
- Regression: `npm test` -> 1216 passed, 3 skipped, 1 pre-existing environment-sensitive failure in `lib/launch.test.js` (`probePort` timeout assertion); no test was removed or skipped.
- Static check: `rg` confirms the three production tail functions no longer call `readFileSync` or `fs.promises.readFile`.
- Benchmark: see `docs/PERFORMANCE_REPORT.md`; 100 MiB synthetic file, 8 MiB tail and 512 KiB recent reads.
- Data safety: no user data path was read or modified.
- Rollback: revert the P0-01 commit; the change is isolated to watcher reads/tests/benchmark.
