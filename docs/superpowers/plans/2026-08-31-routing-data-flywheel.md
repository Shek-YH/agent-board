# Routing Data Flywheel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a safe, read-only workspace view of historical routing outcomes so future routing recommendations can use verified success-rate data without exposing prompts, paths, tokens, or secrets.

**Architecture:** Reuse the existing sanitized dispatch-record store. Add a bounded aggregation function that joins records to workflows only for the safe Agent label, then reports totals, Agent-level rates, and Agent/model/reasoning profiles. Expose that report through a workspace-scoped GET endpoint. Keep the existing per-workflow insights and manual routing pins unchanged; this slice does not automatically change models or execute work across Agents.

**Tech Stack:** Node.js, existing HTTP router, Node test runner, JSON workflow store.

## Task 1: Define the flywheel contract with failing tests

- [ ] Add unit coverage for cross-workflow aggregation, Agent isolation, success/failure classification, malformed-record filtering, and absence of instruction fields.
- [ ] Add HTTP coverage for the workspace-level read-only endpoint and its safe response shape.
- [ ] Run the focused tests and verify they fail because the new function and route do not exist yet.

## Task 2: Implement safe workspace aggregation

- [ ] Add a bounded recent-record limit and normalize only safe Agent/model/reasoning identifiers.
- [ ] Reuse the existing outcome classification while returning Agent-level and Agent/profile-level summaries.
- [ ] Skip records whose workflow cannot be mapped to an Agent rather than guessing ownership.
- [ ] Run the focused unit tests and verify they pass.

## Task 3: Expose the workspace flywheel report

- [ ] Add `GET /api/orchestration/routing/insights` as a read-only workspace endpoint.
- [ ] Read only sanitized store records and workflow metadata; never return prompts, goals, paths, tokens, or credentials.
- [ ] Add a compact read-only entry in the existing Settings hub so the report is discoverable without adding per-Workflow configuration.
- [ ] Run the focused HTTP tests and verify they pass.

## Task 4: Verify and hand off

- [ ] Run the full test suite.
- [ ] Run the front-end contract tests for the Settings hub entry and safe rendering.
- [ ] Review the diff and confirm unrelated untracked distribution directories remain untouched.
- [ ] Commit the implementation on `main`; do not push.
