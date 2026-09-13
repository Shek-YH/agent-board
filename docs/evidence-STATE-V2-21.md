# STATE-V2-21 Evidence — Browser Acceptance and Remaining User Gates

## Verified in this turn

- Started source server on `127.0.0.1:61910` with isolated F-drive data/user directories and `STATE_ENGINE_V2=on`.
- GStack/browse loaded the home page successfully and showed the existing board without console errors.
- Clicked Settings Hub → `状态监控诊断`; empty-state behavior rendered when no V2 runtime existed.
- Sent two synthetic WorkBuddy lifecycle hooks through the isolated server's configured loopback hook; both returned HTTP 202 without exposing the token.
- Reopened diagnostics, selected `workbuddy:browser-session`, and observed canonical `OPEN + COMPLETION_CANDIDATE`, winning evidence and timeline entries.
- Fixed and reverified the detail popover so it remains visible through asynchronous loading and background refresh; `返回列表` and `导出诊断包` rendered.

## Automated verification

- The earlier browser-acceptance full `npm test` — exit 0, 1330 tests, 1327 passed, 3 skipped, 0 failed; the latest post-hardening full regression is recorded in `STATE-V2-28`.
- Final focused State Engine/adapter/bridge/UI suites — all green; latest counts and commands are in the per-Task evidence files.
- `npm run lint`, `npm run check`, `git diff --check` passed before final browser acceptance.

## Waiting for user-controlled acceptance

- Real Codex and WorkBuddy long-running turns, late hooks, same-CWD dual sessions, process crash, sleep/wake, Agent restart and transcript rebind.
- Installed NSIS/manual install and Windows security-software review.
- Any product-owner acceptance of enabling `STATE_ENGINE_V2=on` beyond local synthetic evidence.

These gates require real Agent processes, installed package interaction, or user-owned data/permissions. Synthetic replay and unit tests do not replace them. Keep rollout `off` until these are accepted.

Status: `WAITING_USER`; verification is `SELF_VERIFIED` for the browser/synthetic checks only.
