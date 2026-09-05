# AutoPilot V2.3 Slice 2/3 Implementation Plan

## Goal

Implement the V2.3 Slice 2 + Slice 3 new hosted-task flow and only the Slice 0/1 foundations required to make the flow safe and connected to the existing Session, Workflow, and Auto Loop architecture.

## Constraints

- Preserve existing user changes and existing Agent integrations.
- Do not create a Session, Workflow Run, dispatch, or code execution before explicit Task Contract confirmation.
- Do not invent a Session for Agents without a reliable creation capability.
- Keep existing SEND idempotency and fail-closed delivery verification behavior.
- Do not install dependencies, deploy, publish, push, or delete files.

## Steps

1. Add project context validation in `lib/orchestrator/project-context.js` with tests. Validate canonical path, allowed roots, directory existence/type, read/write access, Git root/branch/dirty state, and secret-file presence without reading secret contents.
2. Add `lib/orchestrator/session-provisioner.js` with tests. Define a narrow provisioner contract, implement Codex App Server `thread/start` provisioning, and return `SESSION_CREATION_UNAVAILABLE` for unsupported Agents instead of creating a synthetic record.
3. Add `lib/orchestrator/permission-snapshot.js` with tests. Normalize and hash a project-scoped permission policy, default secrets/network/install/git-push to denied, and expose immutable snapshot metadata.
4. Extend `lib/orchestrator/settings-store.js`, `lib/orchestrator/workflow-store.js`, `lib/orchestrator/api.js`, and `lib/orchestrator/runtime.js`. Add model/budget/safety settings, immutable Settings/Permission snapshots, project-context intake, duplicate Session resolution, and confirmed Session/Workflow creation while retaining legacy Workflow compatibility.
5. Extend `lib/orchestrator/http.js` and `server.js`. Add project validation, project-based intake preview, draft storage/expiry, explicit confirm/cancel handling, and Codex provisioner wiring. Require confirmation for the existing Session intake route as well.
6. Add backend tests in `lib/orchestrator/http.test.js`, `project-context.test.js`, `session-provisioner.test.js`, `permission-snapshot.test.js`, and `workflow-store.test.js` for empty/no-Session intake, folder errors, contract confirmation, duplicate new/continue, immutable snapshots, and NEED_HUMAN scope/permission failures.
7. Extend `desktop/main.js` and `desktop/preload.js` with a native folder picker that returns only the selected local path; add the unified hosted-task drawer in `public/app.js` and `public/index.html` and connect Agent navigation, empty Agent columns, and existing Session cards to it.
8. Add/update UI source tests for Agent-nav/empty-state entries, folder picker, explicit Task Contract confirmation, and the no-confirmation safety guard.
9. Verify with `npm test`, available lint/typecheck/integration/e2e/build scripts, `npm run desktop:verify`, and `npm run desktop:dist` if the existing packaging toolchain is available. Record failures as risks rather than masking them.

## Verification Criteria

- Preview can run with no existing Session and changes no persisted Session/Workflow/Run state.
- Only an explicit confirm request can provision a real Session and then create a Workflow.
- Same Agent + canonical project offers new/continue; default is new; continue revalidates identity and binding.
- Out-of-scope, secret, network/install/git-push, or unavailable capability paths enter NEED_HUMAN/Fail Closed with no automatic privilege upgrade.
- Settings Snapshot and Permission Snapshot are persisted, hashed, and rejected if later mutated.
