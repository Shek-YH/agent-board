# AI Supervisor MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a project-scoped AI monitoring foundation that separates human session observation from Jarvis-controlled workflows, classifies new versus existing projects, enforces human/AI ownership, and exposes provider slots without coupling the MVP to one model vendor.

**Architecture:** Keep the current Agent Board session adapters, JSON persistence, local HTTP server, and SSE UI. Add a separate orchestration domain where a project has a workflow, a workflow owns a run, and a run may launch a CLI/headless Agent through a transport. Jarvis produces a structured plan; deterministic policy and lifecycle code validate and execute the plan. The human and AI panels are separate read models over the same session/event source and are coordinated by a project control lease.

**Tech Stack:** Node.js built-ins, existing `server.js`, native browser JavaScript, Node test runner, JSON snapshot plus append-only workflow event records; no new runtime dependency in the MVP.

---

### Task 1: Add project classification and normalized execution plans

**Files:**
- Create: `lib/orchestrator/project-classifier.js`
- Create: `lib/orchestrator/project-classifier.test.js`
- Create: `lib/orchestrator/execution-plan.js`
- Create: `lib/orchestrator/execution-plan.test.js`

- [ ] **Step 1: Write failing tests for project classification**

Cover these exact cases: a missing path is `new`; an existing empty directory is `new`; an existing directory containing `.git` is `existing`; an existing directory containing a recognized manifest but no `.git` is `existing_unversioned`; an invalid/non-directory path returns `invalid` without creating anything.

- [ ] **Step 2: Run the focused tests and verify the expected failures**

Run `node --test lib/orchestrator/project-classifier.test.js` from the worktree. The failure must be caused by the missing classifier module or missing exported behavior.

- [ ] **Step 3: Implement the minimal classifier**

Use `fs.statSync` and a small manifest allowlist (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, `composer.json`). Never create folders, initialize Git, or run commands from the classifier.

- [ ] **Step 4: Write failing tests for normalized execution plans**

Assert that a new project plan contains `mode: 'new'`, a canonical project path, `createDirectory: true`, `initializeGit: true`, baseline verification, and no destructive action. Assert that an existing Git project plan contains `mode: 'maintenance'`, preserves the existing path, checks dirty state before work, and does not initialize Git.

- [ ] **Step 5: Implement plan normalization and pass the focused tests**

Expose a pure function that accepts classification plus user goal and returns a serializable plan. The plan must include `requiresApproval` for dependency installation, publishing, deployment, deletion, or overwriting uncommitted files.

- [ ] **Step 6: Run the focused tests again**

Run `node --test lib/orchestrator/project-classifier.test.js lib/orchestrator/execution-plan.test.js` and require all tests to pass.

### Task 2: Add workflow state, ownership leases, and provider capability configuration

**Files:**
- Create: `lib/orchestrator/workflow-store.js`
- Create: `lib/orchestrator/workflow-store.test.js`
- Create: `lib/orchestrator/provider-config.js`
- Create: `lib/orchestrator/provider-config.test.js`

- [ ] **Step 1: Write failing workflow-store tests**

Cover workflow creation, transitions through `draft`, `queued`, `running`, `waiting_user`, `verifying`, `completed`, `failed`, and `paused`; reject illegal transitions; ensure only one active owner exists for a project; allow an expired lease to be reclaimed; and ensure a human takeover pauses AI ownership.

- [ ] **Step 2: Run the focused workflow tests and verify failure**

Run `node --test lib/orchestrator/workflow-store.test.js` and confirm the failure is due to the missing implementation.

- [ ] **Step 3: Implement the minimal persisted workflow store**

Use a dedicated Agent Board data file under the existing local data directory, with atomic snapshot writes and an append-only event list in the same domain. Do not alter the existing session message schema or migrate the existing session store. Store `projectPath`, `workflowId`, `controlOwner`, `leaseExpiresAt`, `mode`, `agent`, `runCount`, and `lastError`.

- [ ] **Step 4: Write provider configuration tests**

Assert that configuration exposes provider slots for `supervisor_llm`, `stt_streaming`, `stt_batch`, `tts_streaming`, `tts_batch`, `voice_clone`, `vision`, `image_generation`, `video_generation`, `embeddings`, and `moderation`; missing keys are reported as unavailable; and secrets are never returned by the configuration API.

- [ ] **Step 5: Implement provider capability discovery**

Read only server-side environment variables or the existing local configuration mechanism. Keep provider and model names configurable; do not hard-code a single vendor into the workflow state. Return capability metadata and masked provider status, never raw keys.

- [ ] **Step 6: Run the focused tests**

Run `node --test lib/orchestrator/workflow-store.test.js lib/orchestrator/provider-config.test.js` and require all tests to pass.

### Task 3: Add a deterministic project lifecycle coordinator

**Files:**
- Create: `lib/orchestrator/project-lifecycle.js`
- Create: `lib/orchestrator/project-lifecycle.test.js`

- [ ] **Step 1: Write failing lifecycle tests**

Test that a new project plan creates the directory, optionally runs `git init`, creates only the declared bootstrap files, and then runs baseline verification. Test that an existing project never overwrites dirty files, detects Git status, and pauses for approval when the repository is unversioned or has uncommitted changes that conflict with the requested action.

- [ ] **Step 2: Run the focused lifecycle tests and verify failure**

Run `node --test lib/orchestrator/project-lifecycle.test.js` and confirm the expected missing-module failure.

- [ ] **Step 3: Implement lifecycle operations with injected executors**

Keep filesystem and command execution behind injected functions so tests can use temporary directories and fake commands. The coordinator may create a new project directory inside an explicitly allowed root, initialize Git for a truly new project, and run allowlisted setup commands. It must reject paths outside the configured roots and never execute delete, publish, deployment, or credential-related commands automatically.

- [ ] **Step 4: Run lifecycle tests and the existing test suite**

Run `node --test lib/orchestrator/project-lifecycle.test.js`, then `node --test`. Existing failures must be recorded before moving on.

### Task 4: Add server APIs and internal events without changing the human monitor contract

**Files:**
- Modify: `server.js`
- Create: `lib/orchestrator/events.js`
- Create: `lib/orchestrator/events.test.js`
- Create: `server-orchestrator.test.js`

- [ ] **Step 1: Write failing tests for the internal event bridge**

Assert that a newly ingested normalized session message emits one orchestration event with the project path, agent, session reference, message timestamp, and event origin; duplicate source IDs do not emit duplicate events; and front-end SSE payload shape remains compatible.

- [ ] **Step 2: Implement the internal event bridge**

Add a small in-process event emitter at the orchestration boundary. It must consume normalized session events after persistence and remain independent from the existing HTTP SSE client list.

- [ ] **Step 3: Write failing HTTP tests for the AI monitor endpoints**

Cover `GET /api/ai-monitor/state`, `GET /api/ai-monitor/providers`, `POST /api/ai-monitor/workflows`, `POST /api/ai-monitor/workflows/:id/pause`, `POST /api/ai-monitor/workflows/:id/takeover`, and `POST /api/ai-monitor/workflows/:id/resume`. Verify that workflow creation validates project roots and that takeover pauses the AI workflow before returning human ownership.

- [ ] **Step 4: Add the endpoints and preserve existing endpoints**

Keep the existing `/api/board`, `/api/session/...`, `/api/open-with`, and `/api/events` behavior unchanged. The new endpoints must return masked provider status and workflow projections only.

- [ ] **Step 5: Run focused server tests and the full test suite**

Run `node --test server-orchestrator.test.js lib/orchestrator/events.test.js`, then `node --test`.

### Task 5: Add the AI monitoring navigation and conflict indicators

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Create: `public/ai-monitor.test.js`

- [ ] **Step 1: Write failing UI source tests**

Assert that the page has two navigable views named `人工监控` and `AI 监控`; the human view remains the default; the AI view renders projects/workflows rather than duplicating every session card; and an AI-owned project in the human view has a visible ownership badge and takeover action.

- [ ] **Step 2: Implement the two-panel projection**

Reuse the current session board for `人工监控`. Add an AI monitor view that reads only workflow projections from `/api/ai-monitor/state`, shows lifecycle state, current Agent, last decision, verification result, run count, and pause reason, and links back to the human session drawer for raw messages.

- [ ] **Step 3: Implement conflict behavior**

Manual takeover must call the server takeover endpoint before enabling manual actions. AI actions must be disabled while `controlOwner === 'human'`. The UI must not silently switch control owners.

- [ ] **Step 4: Run UI source tests and full tests**

Run `node --test public/ai-monitor.test.js`, then `node --test`.

### Task 6: Add a safe headless Agent transport seam

**Files:**
- Create: `lib/orchestrator/transport.js`
- Create: `lib/orchestrator/transport.test.js`
- Create: `lib/orchestrator/runner.js`
- Create: `lib/orchestrator/runner.test.js`

- [ ] **Step 1: Write failing transport tests**

Cover command construction for a configured CLI Agent, working-directory enforcement, environment scrubbing, cancellation, exit-code capture, stdout/stderr event capture, and refusal to run when no transport is configured.

- [ ] **Step 2: Implement the transport interface with a dry-run default**

The first implementation must support a fake transport for tests and an explicit configured CLI transport for real runs. It must not simulate desktop input. It must not accept arbitrary command strings from an LLM; command templates come from trusted Agent configuration.

- [ ] **Step 3: Write failing runner tests**

Assert that a run starts only when the project lease is owned by AI, records each action and result, transitions to `verifying` after a successful Agent exit, pauses on a question/approval signal, and releases the lease on terminal states.

- [ ] **Step 4: Implement the runner and pass focused tests**

Keep the runner independent from the specific Supervisor provider. It accepts a normalized execution plan and a transport, emits structured events, and delegates verification to the lifecycle/verifier seam.

- [ ] **Step 5: Run the full test suite**

Run `node --test` and record the final count and any pre-existing failures.

### Task 7: Document model-provider preparation and operational boundaries

**Files:**
- Modify: `README.md`
- Create: `docs/superpowers/specs/2026-08-25-ai-supervisor-provider-and-lifecycle-design.md`

- [ ] **Step 1: Document required and optional provider capabilities**

Separate MVP-required capabilities from future capabilities: supervisor text model, streaming/batch STT, streaming/batch TTS, vision, image generation, video generation, voice cloning, embeddings, and moderation.

- [ ] **Step 2: Document secrets handling**

State that API keys are server-side only, must not be placed in browser storage or workflow messages, and should be loaded through environment variables or an OS credential store. Include masked capability status in the UI.

- [ ] **Step 3: Document new/existing project execution chains**

Describe the classification rules, approval gates, default Git behavior for truly new projects, treatment of existing unversioned projects, and the human takeover rule.

- [ ] **Step 4: Run final verification**

Run `node --test`; inspect `git diff --check`; confirm no existing user modifications from the main worktree were copied or overwritten.

---

## Self-review checklist

- The human monitor remains the full-session observation surface.
- The AI monitor is a workflow projection and does not duplicate session ownership.
- Global AI takeover is represented as policy scope; project takeover is the active run scope.
- New and existing project flows are explicitly separated.
- Provider keys are optional configuration slots; no secret is persisted in workflow messages or returned by APIs.
- LLM-generated text never becomes an unvalidated shell command.
- Desktop UI automation is not part of the first CI/headless execution path.
- Existing uncommitted worktree changes remain outside this feature branch.
