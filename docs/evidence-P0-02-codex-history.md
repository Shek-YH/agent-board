# P0-02 Evidence: incremental Codex completion history

- Goal: stop rebuilding completion history from a synchronous whole-session JSONL read on every completion signal.
- Changed: `lib/codex-completion-history.js`, `lib/codex-completion-history.test.js`, `lib/adapters/codex.js`.
- Focused test: `node --test lib/codex-completion-history.test.js` -> 2 passed.
- Adapter regression: Codex topology, adapter topology, WorkBuddy topology, Store Codex live, and detect tests -> 87 passed.
- Full regression: `npm test` -> 1218 passed, 3 skipped, 1 pre-existing environment-sensitive failure in `lib/launch.test.js` (`probePort` timeout assertion).
- Behavior: one-turn, multi-turn rapid continuation, timestamp cutoff, duplicate replay, file identity replacement, and truncation are covered.
- Static check: completion history no longer calls `fs.readFileSync(filePath, 'utf8')`; rebuild delegates to `readAll`, which uses the bounded watcher reader.
- Data safety: no user data path was read or modified.
- Rollback: revert the P0-02 commit; P0-01 remains independently revertible.
