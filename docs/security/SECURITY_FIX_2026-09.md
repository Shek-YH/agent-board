# Security Fix 2026-09

## Scope and version

- Scope: the source working tree based on the current `main` checkout.
- Fix commit: pending; this task does not create a Git commit or push without separate authorization.
- This is dependency hardening, not a claim that any prior NestJS version was exploitable in this application.

## Fixed boundaries

### SEC-001: Desktop Runtime Auth route ordering

`server.js` now applies Runtime Auth before dispatching desktop UI mutations. `POST /api/jarvis/voice` and mutation methods under `/api/orchestration/*` therefore require loopback, accepted Host and Origin, JSON content type, bounded body length, and the UI Runtime Bearer Token. WorkBuddy Hook requests remain on their separate token boundary.

### SEC-002: Agent sub-agent scope

`POST /v1/agent/sub-agents` now requires the target User to have an existing `agentId` inside the caller's Agent subtree. Unassigned Users and Users in another Agent tree fail with `AGENT_USER_NOT_IN_SCOPE` or `AGENT_DATA_SCOPE_DENIED` before `agents.create` runs. The existing checks for Agent existence, ADMIN/SUPER_ADMIN conflicts, child permission, depth, audit logging, and transaction remain intact.

This is the documented strict-scope interim protection. A durable invitation/claim flow is not included in this patch; consequently, an unassigned normal User cannot be directly promoted by an Agent.

### SEC-003: Agent completion Hook authentication

`POST /api/complete` now requires a dedicated token from `AGENT_BOARD_COMPLETE_HOOK_TOKEN`, or a fresh 32-byte random token when unset. It also requires a loopback peer, `Authorization: Bearer`, and `application/json`. The token is compared with `timingSafeEqual` and is stored only in `%LOCALAPPDATA%\AgentBoard\hooks\complete-hook.json` (or `AB_DATA_DIR`), with the hook URL. `tools/signal-done.js` reads this private config and supplies the Bearer header. It never uses the UI Runtime or WorkBuddy Hook token.

### Additional hardening

- Cloud `API_HOST` defaults to `127.0.0.1`, accepts only explicit loopback/wildcard addresses, and Compose explicitly sets `0.0.0.0` for its internal container listener.
- Electron external navigation permits only `http:` and `https:`.
- `@nestjs/common`, `@nestjs/core`, and `@nestjs/platform-express` moved from `11.1.6` to `11.2.5`; `package-lock.json` was regenerated. Registry metadata confirmed `11.2.5` as the current compatible 11.x release during this work. The configured npm mirror does not implement `npm audit`, so audit advisory output was unavailable.

## Verification

| Command | Result |
| --- | --- |
| `node --test server-runtime-auth.test.js lib/workbuddy-http.test.js lib/complete-hook-auth.test.js desktop/external-url.test.js` | 8 passed, 0 failed |
| `cd cloud; node --test apps/api/src/config.test.js apps/api/src/main.test.js apps/api/src/agent-subagent-authorization.test.js apps/api/src/agent.service.test.js` | 14 passed, 0 failed |
| `cd cloud; npm run build` | passed |
| `npm run check` | passed |
| `npm audit --omit=dev --json` | not available: configured registry returned `404 NOT_IMPLEMENTED` for its audit endpoint |

## Compatibility

- Desktop UI already obtains the Runtime Token from `/api/runtime-auth`; no renderer contract changed.
- Source mode retains its existing Runtime Auth behavior. Desktop mode remains enforced.
- Existing completion hooks must invoke `tools/signal-done.js` after the server has created the private hook config. Direct legacy unauthenticated POSTs now correctly receive `401`.
- Cloud deployments that expose the API inside Docker must set `API_HOST=0.0.0.0`; the provided Compose file does so explicitly.

## Remaining risks

- The strict-scope solution intentionally does not solve opt-in onboarding for an unassigned User; use a transactional invitation/claim model for that product flow.
- No installed-NSIS/manual browser acceptance was performed in this source patch.
- These changes reduce the listed trust-boundary issues; they do not establish an absolute-security claim.
