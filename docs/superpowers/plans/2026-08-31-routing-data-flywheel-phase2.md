# Routing Data Flywheel Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing safe routing counters into task-level historical profiles and read-only automatic Profile recommendations.

**Architecture:** Derive a sanitized task outcome from stored Workflow classification, terminal Run Receipt, timestamps, and safe event types. Aggregate task classes and Agent/model/reasoning profiles independently from raw dispatch counters, then recommend only from same-Agent and same-task-class profiles with at least three completed samples. Expose the result through the existing workspace insights endpoint and Settings hub; recommendations never mutate Workflow routing, bypass a manual pin, or start another Agent.

**Tech Stack:** Node.js CommonJS, existing HTTP orchestration handler, JSON WorkflowStore, Node test runner, existing browser-contract tests.

## Task 1: Lock the task-image and recommendation contracts with failing tests

**Files:**
- Modify: `lib/orchestrator/routing/insights.test.js`
- Modify: `lib/orchestrator/workflow-store.test.js`
- Modify: `lib/orchestrator/http.test.js`

- [ ] **Step 1: Write failing unit tests** for terminal Workflow outcomes, task-class aggregation, duration/iteration/DoD/stagnation/human-intervention metrics, sensitive-field exclusion, and recommendation refusal below the three-sample threshold.
- [ ] **Step 2: Run `node --test lib/orchestrator/routing/insights.test.js lib/orchestrator/workflow-store.test.js lib/orchestrator/http.test.js`** and confirm the new exports and event reader fail because they do not exist yet.

## Task 2: Implement safe task history and event access

**Files:**
- Modify: `lib/orchestrator/workflow-store.js`
- Modify: `lib/orchestrator/routing/insights.js`

- [ ] **Step 1: Add `WorkflowStore.listEvents(workflowId)`** returning only `{ type, workflowId, at }` for safe human-intervention detection.
- [ ] **Step 2: Add `aggregateHistoricalTaskOutcomes({ workflows, events, maxRecords })`**. Count only terminal `DONE`, `BLOCKED`, or `STOPPED` receipts; normalize task class to known project classes or `unknown`; return task-class and task-profile summaries with attempts, success rate, average iterations, average duration, average DoD completion, human interventions, and average stagnation.
- [ ] **Step 3: Add `recommendHistoricalProfile(...)`**. Filter on exact Agent and task class, require three completed samples per profile, then reuse the existing supported-catalog/manual-pin-safe resolver for a read-only result.
- [ ] **Step 4: Extend `aggregateWorkspaceRoutingOutcomes`** with the historical task summaries while preserving its existing dispatch-counter fields.
- [ ] **Step 5: Run the focused tests and confirm they pass.**

## Task 3: Return recommendations from the workspace API

**Files:**
- Modify: `lib/orchestrator/http.js`
- Modify: `lib/orchestrator/http.test.js`

- [ ] **Step 1: Read sanitized WorkflowStore events and records only.**
- [ ] **Step 2: For each known task class of a Model-Routing-capable Agent, read the current Catalog and compute a recommendation from same-Agent/same-class history; return `{ agent, taskClass, sampleSize, reasonCode, profile }` summaries.
- [ ] **Step 3: Keep unavailable or unsupported Agents visible in the existing capability API, but never produce a model recommendation for an Agent without verified model switching.**
- [ ] **Step 4: Run the focused HTTP tests and confirm recommendation selection, threshold handling, manual-pin safety, and sensitive-field exclusion.**

## Task 4: Make the data flywheel useful in the existing UI

**Files:**
- Modify: `public/app.js`
- Modify: `public/ai-monitor-contract.test.js`

- [ ] **Step 1: Render task-class metrics and recommendation status in the existing read-only flywheel popover.**
- [ ] **Step 2: Label recommendations as suggestions and show insufficient-history/unavailable reasons instead of implying automatic application.**
- [ ] **Step 3: Run the front-end contract tests and confirm no sensitive fields are rendered.**

## Task 5: Verify and commit

- [ ] **Step 1: Run `node --check` on each changed JavaScript file and `git diff --check`.**
- [ ] **Step 2: Run `npm test` and confirm zero failures.**
- [ ] **Step 3: Review `git status --short --branch`; stage only the Phase 2 plan, implementation, and tests, leaving historical `dist-*` directories untouched.**
- [ ] **Step 4: Commit on `main` with `feat: add task-aware routing recommendations`; do not push.**
