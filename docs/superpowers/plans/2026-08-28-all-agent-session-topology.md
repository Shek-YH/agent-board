# All-Agent Session Topology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Distinguish main sessions from verified child/subagent activity for every Agent Board adapter that exposes reliable evidence, and render every resulting card through the same topology presentation used by Codex.

**Architecture:** Keep provider-specific detection inside each adapter and emit the existing normalized topology fields (`sessionRole`, `parentSessionId`, `rootSessionId`, `childDetection`, `controlEligibility`). Reuse the existing store summaries and `public/app.js` topology markup without provider-specific card templates. For products that persist only an embedded delegation span, create a stable synthetic, non-controllable child session keyed by the provider's explicit subagent/delegation ID; its jump action must open the durable parent conversation rather than sending a synthetic ID to the native app. Never infer child status from titles or lineage-only fields.

**Tech Stack:** Node.js built-ins, Node test runner, `node:sqlite`, JSONL adapters, existing Agent Board topology/store/UI modules.

---

### Task 1: Harden Claude child identity and implement WorkBuddy child transcripts

**Files:**
- Modify: `lib/adapters/claude.js`
- Modify: `lib/adapters/topology.test.js`
- Modify: `lib/adapters/workbuddy.js`
- Create: `lib/adapters/workbuddy-topology.test.js`

- [ ] **Step 1: Write failing Claude and WorkBuddy tests**

Add assertions equivalent to:

```js
const childPath = path.join('C:\\data', 'parent-1', 'subagents', 'agent-worker-a.jsonl');
assert.equal(claude.fileToSessionId(childPath), 'parent-1:subagent:worker-a');

const child = workbuddy.parseLines([
  { type: 'message', id: 'm1', sessionId: 'child-session-1', timestamp: 1000,
    role: 'assistant', content: 'done', cwd: 'C:\\project' },
], childPath)[0];
assert.equal(child.sessionId, 'child-session-1');
assert.equal(child.sessionRole, 'child');
assert.equal(child.parentSessionId, 'parent-1');
assert.equal(child.controlEligibility, 'blocked');
assert.equal(workbuddy.fileToSessionId(childPath), 'child-session-1');
```

Also assert that a normal WorkBuddy project JSONL is `main/eligible`, and that a child file without an embedded `sessionId` falls back to `parent-1:subagent:worker-a` rather than becoming a main card.

- [ ] **Step 2: Run tests to verify RED**

Run:

```text
node --test lib/adapters/topology.test.js lib/adapters/workbuddy-topology.test.js
```

Expected: FAIL because WorkBuddy does not accept file context and Claude/WorkBuddy `fileToSessionId()` do not return child identities.

- [ ] **Step 3: Implement minimal path-based topology**

In both adapters, match only the verified suffix:

```js
const match = String(filePath || '').match(
  /[\\/]([^\\/]+)[\\/]subagents[\\/]agent-([^\\/]+)\.jsonl$/i,
);
```

For Claude, use the parent directory as the primary parent ID and keep the transcript `sessionId` as compatibility fallback. Make `fileToSessionId()` return the same composite child ID as parsing.

For WorkBuddy, add a cached first-record `sessionId` reader. `workbuddyFileTopology(filePath, lines)` must use the child transcript's own UUID when present, the parent directory for `parentSessionId`, and the filename for fallback identity. Apply the topology to title/message events, pass `filePath` from `scanAll()` and `poll()`, and version the offset key so existing child files are replayed once:

```js
const key = `offset:topology-v2:${ID}:${f}`;
```

- [ ] **Step 4: Verify GREEN**

Run:

```text
node --test lib/adapters/topology.test.js lib/adapters/workbuddy-topology.test.js lib/workbuddy-heartbeat.test.js
```

Expected: PASS.

### Task 2: Implement DeepSeek Harness native child sessions

**Files:**
- Modify: `lib/adapters/deepseek.js`
- Modify: `lib/adapters/deepseek.test.js`

- [ ] **Step 1: Write failing topology tests**

Cover all official rules:

```js
const childLines = [
  { type: 'session', id: 'child-1', cwd: 'C:\\project', origin: 'subagent',
    parentSession: 'parent-1', delegationDepth: 1 },
  { type: 'assistant/message', seq: 1, time: 1000,
    data: { message: { content: [{ type: 'text', text: 'done' }] } } },
];
const child = deepseek.parseLines(childLines).find((event) => event.kind === 'message');
assert.equal(child.sessionRole, 'child');
assert.equal(child.parentSessionId, 'parent-1');
assert.equal(child.controlEligibility, 'blocked');
```

Also assert:

- `subagent/descriptor` is accepted as durable child evidence.
- `parentSession` without `origin:'subagent'` or descriptor remains a main/fork session.
- a normal header becomes `main/eligible` with verified detection.

- [ ] **Step 2: Run test to verify RED**

Run: `node --test lib/adapters/deepseek.test.js`

Expected: FAIL because parsed events have no topology metadata.

- [ ] **Step 3: Add official header/descriptor classification**

Add a pure helper that scans the complete session artifact before emitting events:

```js
function topologyForSession(lines) {
  const header = lines.find((line) => line?.type === 'session') || {};
  const descriptor = lines.find((line) => line?.type === 'subagent/descriptor');
  if (header.origin === 'subagent' || descriptor) {
    return {
      sessionRole: 'child',
      parentSessionId: String(header.parentSession || '') || undefined,
      rootSessionId: String(header.parentSession || '') || undefined,
      topologySource: header.origin === 'subagent' ? 'explicit' : 'structural',
      topologyConfidence: 1,
      childDetection: 'verified',
      controlEligibility: 'blocked',
    };
  }
  return {
    sessionRole: 'main', topologySource: 'explicit', topologyConfidence: 1,
    childDetection: 'verified', controlEligibility: 'eligible',
  };
}
```

Spread the topology onto title/message/turn events and bump the mtime replay key from `mtime:v2` to `mtime:v3`.

- [ ] **Step 4: Verify GREEN**

Run: `node --test lib/adapters/deepseek.test.js lib/deepseek-status.test.js`

Expected: PASS.

### Task 3: Split Marvis explicit subagent metadata into child cards

**Files:**
- Modify: `lib/adapters/marvis.js`
- Modify: `lib/adapters/marvis.test.js`

- [ ] **Step 1: Write failing metadata tests**

Export a pure metadata helper and assert:

```js
assert.deepEqual(
  marvis.topologyForMessage('conv-1', JSON.stringify({
    subagent: { id: 'sa-1', name: 'File Agent' },
  })),
  {
    sessionId: 'conv-1:subagent:sa-1',
    title: 'File Agent',
    sessionRole: 'child',
    parentSessionId: 'conv-1',
    rootSessionId: 'conv-1',
    topologySource: 'explicit',
    topologyConfidence: 1,
    childDetection: 'verified',
    controlEligibility: 'blocked',
  },
);
```

Malformed metadata and metadata without `subagent.id` must return the normal main-session topology. Add an in-memory SQLite test proving subagent rows are ingested into the child ref while ordinary rows remain in the parent conversation.

- [ ] **Step 2: Run test to verify RED**

Run: `node --test lib/adapters/marvis.test.js`

Expected: FAIL because all message rows currently use the conversation ID.

- [ ] **Step 3: Route rows by explicit subagent ID**

Extend the messages query to include `metadata`. For rows with `metadata.subagent.id`, use the stable synthetic child ID `conversationId:subagent:subagentId`, attach the explicit topology, and set the child title from `subagent.name`. Keep ordinary rows on the main conversation. Bump the message offset namespace to replay existing rows once:

```js
const offsetKey = `offset:topology-v2:${ID}:${convId}`;
```

Do not inspect the conversation title or infer worker status from names.

- [ ] **Step 4: Verify GREEN**

Run: `node --test lib/adapters/marvis.test.js lib/store-topology.test.js`

Expected: PASS.

### Task 4: Support persistent Pi subagent-extension transcripts

**Files:**
- Modify: `lib/adapters/pi.js`
- Modify: `lib/pi-session-id.test.js`

- [ ] **Step 1: Write failing path/header tests**

Create temporary top-level and `subagents/` JSONL files. Assert that only the `subagents/` path proves child status:

```js
const childHeader = {
  type: 'session', id: 'pi-child-1', cwd: 'C:\\project', parentSession: 'pi-parent-1',
};
assert.equal(pi.piFileTopology(childPath, childHeader).sessionRole, 'child');
assert.equal(pi.piFileTopology(childPath, childHeader).parentSessionId, 'pi-parent-1');
assert.equal(pi.piFileTopology(topLevelPath, childHeader).sessionRole, 'main');
```

The last assertion prevents `/fork`, `/clone`, or `newSession({parentSession})` from being misclassified. Assert child control is blocked and top-level control stays eligible.

- [ ] **Step 2: Run test to verify RED**

Run: `node --test lib/pi-session-id.test.js`

Expected: FAIL because Pi ignores the `subagents/` path and header parent.

- [ ] **Step 3: Add extension-specific topology**

Add `readSessionHeader(file)` and `piFileTopology(filePath, header)`. Match only:

```js
/[\\/]subagents[\\/][^\\/]+\.jsonl$/i
```

Use `header.parentSession` only to link a path-proven child; never use it as the child predicate. Apply topology to emitted messages and turn-end events. Version the offset key to replay existing extension transcripts once. Do not fabricate cards for the official `--no-session` example because it has no persistent artifact.

- [ ] **Step 4: Verify GREEN**

Run: `node --test lib/pi-session-id.test.js lib/session-topology.test.js`

Expected: PASS.

### Task 5: Project Hermes `delegate_task` spans as non-controllable child cards

**Files:**
- Modify: `lib/adapters/hermes.js`
- Modify: `lib/adapters/hermes.test.js`

- [ ] **Step 1: Write failing delegation tests**

Add rows shaped like the local Hermes `state.db`:

```js
const start = {
  id: 30, role: 'assistant', timestamp: 1787573000,
  finish_reason: 'tool_calls',
  tool_calls: JSON.stringify([{ id: 'call-1', function: {
    name: 'delegate_task', arguments: JSON.stringify({ goal: 'Inspect files', role: 'explorer' }),
  } }]),
};
const finish = {
  id: 31, role: 'tool', timestamp: 1787573001,
  tool_name: 'delegate_task', tool_call_id: 'call-1',
  content: JSON.stringify({ results: [{ task_index: 0, status: 'completed', summary: 'Done' }] }),
};
```

Assert the adapter emits a child session `parent-1:subagent:call-1:0`, parent/root refs, blocked control, a user goal message at start, an assistant summary at finish, and a child turn-end. Assert that `session.parent_session_id` alone does not classify a stored DB session as a child.

Also cover batched `arguments.tasks[]`, which must create one stable child per task index.

- [ ] **Step 2: Run test to verify RED**

Run: `node --test lib/adapters/hermes.test.js`

Expected: FAIL because tool/delegation rows are currently skipped.

- [ ] **Step 3: Parse explicit delegation spans**

Add JSON-safe helpers for tool calls and result payloads. Create topology only when the function/tool name is exactly `delegate_task`; use `tool_call_id` plus task index as stable synthetic child identity. The start row provides the child goal/title and the result row provides summary/terminal status. Keep ordinary Hermes session rows as main sessions and do not use `sessions.parent_session_id` as a predicate.

Version Hermes message offsets (`offset:topology-v2:hermes:<sid>`) so persisted delegation history is projected once after upgrade.

- [ ] **Step 4: Verify GREEN**

Run: `node --test lib/adapters/hermes.test.js server-hermes-monitoring.test.js`

Expected: PASS.

### Task 6: Publish verified capabilities and verify Codex-aligned card output

**Files:**
- Modify: `lib/session-topology.js`
- Modify: `lib/session-topology-capabilities.test.js`
- Modify: `lib/store-topology.test.js`
- Modify: `public/app.js`
- Modify: `public/session-card-topology.test.js`
- Modify: `public/marvis-session-jump.test.js`
- Modify: `public/hermes-session-jump.test.js`

- [ ] **Step 1: Write failing capability and multi-agent card tests**

Assert `deepseek`, `workbuddy`, `marvis`, `pi`, and `hermes` declare their exact evidence and verified child detection. Default main sessions become `eligible`; explicit/synthetic child events remain `blocked`. Add store assertions covering a parent/child pair from at least WorkBuddy and Hermes, including `child_count` and `parent_session_ref`.

Keep the UI source contract agent-agnostic: all cards must continue to use `topologyRoleMarkup(s)`, `topology-${topologyRole}`, and the Codex text/styles (`◎ 主会话`, `↳ 子代理`, parent line, child counts). Do not add provider-specific CSS or card templates. Add a small navigation helper so only the known synthetic projections (`marvis` and `hermes` child refs containing `:subagent:`) open their durable `parent_session_ref`; native child sessions keep their own ID.

- [ ] **Step 2: Run tests to verify RED**

Run:

```text
node --test lib/session-topology-capabilities.test.js lib/store-topology.test.js public/session-card-topology.test.js
```

Expected: FAIL because five adapters are still declared unsupported.

- [ ] **Step 3: Update only the capability matrix/tests**

Set each newly supported adapter to `childDetection:'verified'`, `defaultRole:'main'`, and `defaultControl:'eligible'`, with evidence strings matching the implemented detector. Leave Claude, ZCode, and Codex behavior unchanged. Implement the safe jump helper as:

```js
function sessionNavigationId(s) {
  const syntheticChild = s?.session_role === 'child'
    && (s.agent === 'marvis' || s.agent === 'hermes')
    && String(s.session_id || '').includes(':subagent:');
  if (!syntheticChild || !s.parent_session_ref) return s.session_id;
  const prefix = `${s.agent}:`;
  return String(s.parent_session_ref).startsWith(prefix)
    ? String(s.parent_session_ref).slice(prefix.length)
    : s.session_id;
}
```

Use its result only as the native jump target; keep `data-session-id`, card identity, copy ID, topology relations, and drawer lookup bound to the child card itself.

- [ ] **Step 4: Run focused and full verification**

Run:

```text
node --test lib/adapters/topology.test.js lib/adapters/workbuddy-topology.test.js lib/adapters/deepseek.test.js lib/adapters/marvis.test.js lib/pi-session-id.test.js lib/adapters/hermes.test.js lib/session-topology.test.js lib/session-topology-capabilities.test.js lib/store-topology.test.js public/session-card-topology.test.js
npm test
git diff --check
```

Expected: focused tests PASS; full suite PASS with 0 failures; `git diff --check` produces no output.
