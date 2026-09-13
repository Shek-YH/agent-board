# State Engine V2 Final Local Audit

## Current result

All implementable local PRD work is present on top of the `origin/main` baseline in the local State Engine V2 branch. The V2 path is opt-in and defaults to `STATE_ENGINE_V2=off`.

## Verified evidence

- Canonical five-dimension runtime, immutable Evidence normalization, per-source watermark and attribute authority arbitration.
- Reducer/replay with Turn vs Session separation, waiting/failed/interrupted states, child-session guard and duplicate/late-event handling.
- Codex and WorkBuddy metadata-only adapters, Store bridge, manifest-backed adapter contract and all-current-agent capability manifests.
- Separate atomic V2 persistence, identity/generation restore, conservative non-active restart recovery, process liveness debounce and source health.
- Deterministic completion IDs, notification dedupe, diagnostics API/bundle/UI and bounded high-frequency queue.
- 32 named P0 scenario matrix, 8 golden fixture directories, full Store/UI synthetic smoke and GStack browser click flow.
- Source worktree `npm test`: exit 0, 1387 tests, 1384 passed, 3 skipped, 0 failed.
- Literal `main` tracked-test run: exit 0, 1371 tests, 1368 passed, 3 skipped, 0 failed.
- Literal `main` ordinary `npm test`: exit 0, 1379 tests, 1376 passed, 3 skipped, 0 failed; the preserved untracked `dist-main-20260913/` adds 8 discovered tests.
- Literal `main` `npm run lint`, `npm run check`, `git diff --check`: exit 0.
- Read-only real-data adapter smoke: Codex 872 files / 33,229 parsed / 33,229 Evidence; WorkBuddy 267 files / 12,558 parsed / 12,383 Evidence.
- Fresh `main` NSIS/unpacked package `dist-state-engine-v2-20260913/`: electron-builder and package verifier passed; isolated packaged Electron smoke passed against `/api/ready`, `/api/state` and `/api/health`.

## Not proven locally

- Live Codex/WorkBuddy long-running, crash, sleep/wake, same-CWD dual-session and real transcript/process rebind behavior.
- Installed NSIS/manual installation and Windows security-software review.
- Product-owner authorization to enable `STATE_ENGINE_V2=on` in a real user environment.

These remain `WAITING_USER` in `.ai-ledger/tasks.json`; no synthetic result is promoted to real acceptance.

## Safety and Git

- No push or deployment was performed.
- The untracked `Microsoft/` directory was observed before staging and intentionally preserved.
- No credentials, tokens, cookies, prompts, replies or transcript bodies were added to V2 records, fixtures, diagnostics or commits.
- The latest WorkBuddy turn-identity hardening is recorded in `docs/evidence-STATE-V2-28.md`.
- The fresh package smoke and its timeout-harness fix are recorded in `docs/evidence-STATE-V2-29.md`.
