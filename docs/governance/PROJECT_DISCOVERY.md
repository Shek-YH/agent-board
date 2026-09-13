# Agent Board State Engine V2 — Project Discovery

## Baseline

- Project root: `C:\Users\Administrator\WorkBuddy\2026-08-20-03-52-10\agent-board`
- Effective baseline: `origin/main` / `17f80ce`
- Worktree: clean at intake; current branch name is `codex/agent-board-architecture-hardening` because the literal `main` ref is checked out by another non-source build worktree.
- Stack: Node.js built-in HTTP backend, CommonJS JavaScript, native browser UI, Node test runner, ESLint, TypeScript `checkJs`, Electron packaging.

## Existing state paths

- `lib/store.js`: compatibility status maps, message ingest, completion broadcast, persistence bridge.
- `lib/codex-status.js`: Codex runtime/activity parsing and legacy public status.
- `lib/workbuddy-monitor.js`: WorkBuddy hook lifecycle, completion stabilization and notifications.
- `lib/session-lifecycle/`: prior additive lifecycle engine used by existing compatibility code.
- `lib/adapters/codex.js` and `lib/adapters/workbuddy.js`: source-specific collection/parsing.
- `server.js` / `public/app.js`: API/SSE/UI projection and interaction surfaces.

## Baseline commands

```text
npm test
npm run lint
npm run check
git diff --check
```

The repository-specific test rule is `npm test`; do not pass a directory to `node --test`.

## Scope classification

COMPLEX. The PRD spans a deterministic core, two adapters, persistence/recovery, HTTP diagnostics, browser UI and real-agent acceptance. Work Items stay single-subsystem and dependency ordered.
