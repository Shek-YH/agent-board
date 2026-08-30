# Slice 1 Capability Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为现有 Agent Board 建立可校验、只读报告、可复用的 Capability Registry，并让 Codex/Hermes Verified Dispatch 从 Registry 获取依赖。

**Architecture:** 新增 lib/capability-layer.js 作为纯函数 Contract/Registry，不触碰 Adapter 的数据读取实现。server.js 在现有 Adapter 列表上构建统一 Registry：所有 Adapter 暴露读取 binding，Codex/Hermes 额外暴露已存在的会话激活、身份验证、写入和送达校验实现；Verified Dispatch 只消费 Registry 的能力。

**Tech Stack:** Node.js CommonJS、Node 内置 node:test、现有 HTTP 服务和现有 Codex/Hermes UIA/Deep Link/Delivery 模块；不引入第三方依赖。

---

## 文件边界

- Create: lib/capability-layer.js — 固定能力名称、能力描述校验、不可变能力集合和 Registry。
- Create: lib/capability-layer.test.js — Contract/Registry 单元测试。
- Modify: server.js — 注册现有 Adapter 能力、通过 Registry 组装 Verified Dispatch 依赖、增加只读 /api/capabilities 报告接口。
- Modify: server-verified-dispatch.test.js — 验证服务端使用 Registry 且能力报告路由只读安全。
- Do not modify: lib/adapters/*.js、lib/codex-desktop-uia.js、lib/hermes-desktop-uia.js、lib/codex-delivery.js、lib/hermes-delivery.js；本计划只引用它们已有导出。

## Task 1: 添加 Capability Contract 的失败测试

**Files:**

- Create: lib/capability-layer.test.js

- [ ] **Step 1: 写入 Contract/Registry 的失败测试**

新增以下测试文件。测试中的七个能力必须全部显式声明，测试会先因为生产模块不存在而失败：

~~~js
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CAPABILITY_NAMES,
  createCapabilitySet,
  createCapabilityRegistry,
} = require('./capability-layer');

const implementation = () => ({ ok: true });

function definitions(overrides = {}) {
  const base = Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, {
    supported: false,
    implementation: null,
    source: 'unavailable',
    reason: name + ' is not connected',
  }]));
  base.sessionLocator = {
    supported: true,
    implementation,
    source: 'core',
  };
  return { ...base, ...overrides };
}

test('creates a complete immutable capability set and exposes supported values', () => {
  const set = createCapabilitySet('codex', definitions({
    messageWriter: {
      supported: true,
      implementation: { write: implementation, send: implementation },
      source: 'uia',
    },
  }));

  assert.equal(set.agentId, 'codex');
  assert.equal(set.has('sessionLocator'), true);
  assert.equal(set.get('sessionLocator').implementation, implementation);
  assert.equal(set.get('messageWriter').supported, true);
  assert.equal(set.has('unknown'), false);
  assert.equal(Object.isFrozen(set), true);
  assert.equal(Object.isFrozen(set.capabilities), true);
  assert.throws(() => { set.capabilities.sessionLocator = null; }, TypeError);
});

test('requires every known capability and rejects unknown names', () => {
  const missing = definitions();
  delete missing.completionDetector;
  assert.throws(() => createCapabilitySet('codex', missing), TypeError);

  assert.throws(() => createCapabilitySet('codex', {
    ...definitions(),
    extraCapability: {
      supported: false,
      implementation: null,
      source: 'unavailable',
      reason: 'not supported',
    },
  }), TypeError);
});

test('requires an implementation for supported capability and a reason for unsupported capability', () => {
  assert.throws(() => createCapabilitySet('codex', definitions({
    sessionLocator: {
      supported: true,
      implementation: null,
      source: 'core',
    },
  })), TypeError);

  assert.throws(() => createCapabilitySet('codex', definitions({
    sessionActivator: {
      supported: false,
      implementation: null,
      source: 'unavailable',
    },
  })), TypeError);

  assert.throws(() => createCapabilitySet('codex', definitions({
    sessionActivator: {
      supported: false,
      implementation,
      source: 'unavailable',
      reason: 'not supported',
    },
  })), TypeError);
});

test('reports safe capability metadata without exposing implementations', () => {
  const set = createCapabilitySet('codex', definitions());
  const report = set.report();

  assert.deepEqual(report, {
    agentId: 'codex',
    capabilities: Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, {
      supported: name === 'sessionLocator',
      source: name === 'sessionLocator' ? 'core' : 'unavailable',
      ...(name === 'sessionLocator' ? {} : { reason: name + ' is not connected' }),
    }])),
  });
  assert.equal('implementation' in report.capabilities.sessionLocator, false);
  assert.equal('implementation' in report.capabilities.sessionActivator, false);
});

test('registers agents, rejects duplicates, and returns null for unknown agents', () => {
  const registry = createCapabilityRegistry([
    { agentId: 'codex', capabilities: definitions() },
    { agentId: 'hermes', capabilities: definitions() },
  ]);

  assert.equal(registry.has('codex'), true);
  assert.equal(registry.get('hermes').agentId, 'hermes');
  assert.equal(registry.get('missing'), null);
  assert.deepEqual(registry.list().map((item) => item.agentId), ['codex', 'hermes']);
  assert.deepEqual(registry.report().map((item) => item.agentId), ['codex', 'hermes']);
  assert.throws(() => createCapabilityRegistry([
    { agentId: 'codex', capabilities: definitions() },
    { agentId: 'codex', capabilities: definitions() },
  ]), TypeError);
});

test('does not retain a mutable definitions object or expose implementation through reports', () => {
  const input = definitions();
  const registry = createCapabilityRegistry([{ agentId: 'codex', capabilities: input }]);
  input.sessionLocator.source = 'tampered';
  input.sessionLocator.implementation = null;

  assert.equal(registry.get('codex').get('sessionLocator').source, 'core');
  assert.equal(registry.report()[0].capabilities.sessionLocator.source, 'core');
});
~~~

- [ ] **Step 2: 运行失败测试**

Run:

~~~powershell
node --test lib/capability-layer.test.js
~~~

Expected: FAIL because ./capability-layer does not exist yet. If the failure is a syntax error in the test, fix only the test before proceeding; do not add production code in this step.

## Task 2: 实现 Capability Contract 与 Registry

**Files:**

- Create: lib/capability-layer.js
- Test: lib/capability-layer.test.js

- [ ] **Step 1: 添加最小 Contract/Registry 实现**

创建以下生产文件，使 Task 1 的测试通过：

~~~js
'use strict';

const CAPABILITY_NAMES = Object.freeze([
  'sessionLocator',
  'sessionActivator',
  'conversationReader',
  'identityVerifier',
  'messageWriter',
  'deliveryVerifier',
  'completionDetector',
]);

const CAPABILITY_NAME_SET = new Set(CAPABILITY_NAMES);

function typeError(message) {
  return new TypeError('Invalid capability contract: ' + message);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isImplementation(value) {
  return typeof value === 'function'
    || (value !== null && typeof value === 'object' && !Array.isArray(value));
}

function normalizeMethods(value, name) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => !text(item))) {
    throw typeError(name + '.methods must be an array of non-empty strings');
  }
  return Object.freeze([...new Set(value.map(text))]);
}

function createCapabilitySet(agentId, definitions) {
  const id = text(agentId);
  if (!id) throw typeError('agentId must be a non-empty string');
  if (definitions === null || typeof definitions !== 'object' || Array.isArray(definitions)) {
    throw typeError(id + ' capabilities must be an object');
  }

  const names = Object.keys(definitions);
  if (names.length !== CAPABILITY_NAMES.length || names.some((name) => !CAPABILITY_NAME_SET.has(name))) {
    throw typeError(id + ' must declare exactly the known capabilities');
  }

  const normalized = {};
  for (const name of CAPABILITY_NAMES) {
    const definition = definitions[name];
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      throw typeError(id + '.' + name + ' must be an object');
    }
    if (typeof definition.supported !== 'boolean') {
      throw typeError(id + '.' + name + '.supported must be boolean');
    }
    const source = text(definition.source);
    if (!source) throw typeError(id + '.' + name + '.source must be non-empty');
    const methods = normalizeMethods(definition.methods, id + '.' + name);

    if (definition.supported) {
      if (!isImplementation(definition.implementation)) {
        throw typeError(id + '.' + name + '.implementation is required when supported');
      }
      normalized[name] = Object.freeze({
        name,
        supported: true,
        implementation: definition.implementation,
        source,
        ...(methods ? { methods } : {}),
      });
      continue;
    }

    if (definition.implementation !== null) {
      throw typeError(id + '.' + name + '.implementation must be null when unsupported');
    }
    const reason = text(definition.reason);
    if (!reason) throw typeError(id + '.' + name + '.reason is required when unsupported');
    normalized[name] = Object.freeze({
      name,
      supported: false,
      implementation: null,
      source,
      reason,
      ...(methods ? { methods } : {}),
    });
  }

  const capabilities = Object.freeze(normalized);
  const set = {
    agentId: id,
    capabilities,
    has(name) {
      return CAPABILITY_NAME_SET.has(name) && capabilities[name] !== undefined;
    },
    get(name) {
      return set.has(name) ? capabilities[name] : null;
    },
    report() {
      return {
        agentId: id,
        capabilities: Object.fromEntries(CAPABILITY_NAMES.map((name) => {
          const capability = capabilities[name];
          return [name, {
            supported: capability.supported,
            source: capability.source,
            ...(capability.reason ? { reason: capability.reason } : {}),
          }];
        })),
      };
    },
  };
  return Object.freeze(set);
}

function createCapabilityRegistry(definitions) {
  if (!Array.isArray(definitions)) throw typeError('registry definitions must be an array');
  const sets = new Map();
  for (const definition of definitions) {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      throw typeError('registry definition must be an object');
    }
    const set = createCapabilitySet(definition.agentId, definition.capabilities);
    if (sets.has(set.agentId)) throw typeError('duplicate agentId: ' + set.agentId);
    sets.set(set.agentId, set);
  }
  return Object.freeze({
    has(agentId) {
      return sets.has(text(agentId));
    },
    get(agentId) {
      return sets.get(text(agentId)) || null;
    },
    list() {
      return [...sets.values()];
    },
    report() {
      return [...sets.values()].map((set) => set.report());
    },
  });
}

module.exports = {
  CAPABILITY_NAMES,
  createCapabilitySet,
  createCapabilityRegistry,
};
~~~

- [ ] **Step 2: 运行 Contract 测试并确认通过**

Run:

~~~powershell
node --test lib/capability-layer.test.js
~~~

Expected: all 6 tests pass. Then run git diff --check and commit only these two files:

~~~powershell
git diff --check
git add -- lib/capability-layer.js lib/capability-layer.test.js
git commit -m "feat: add capability contract registry"
~~~

## Task 3: 为服务端接入统一 Registry

**Files:**

- Modify: server.js
- Modify: server-verified-dispatch.test.js

- [ ] **Step 1: 先添加服务端集成的失败断言**

在 server-verified-dispatch.test.js 追加：

~~~js
test('verified dispatch dependencies are resolved from the capability registry', () => {
  assert.match(serverSource, /require\('\.\/lib\/capability-layer'\)/);
  assert.match(serverSource, /createCapabilityRegistry\(/);
  assert.match(serverSource, /AGENT_CAPABILITY_REGISTRY\.get\(agent\)/);

  const factoryStart = serverSource.indexOf('function createVerifiedDispatchDependencies');
  const factoryEnd = serverSource.indexOf('\nfunction verifiedDispatchHttpStatus', factoryStart);
  const factory = serverSource.slice(factoryStart, factoryEnd);
  assert.doesNotMatch(factory, /if \(agent === 'codex'\)/);
  assert.doesNotMatch(factory, /if \(agent === 'hermes'\)/);
});

test('capability report is exposed as a read-only safe API', () => {
  assert.match(serverSource, /pathname === '\/api\/capabilities' && req\.method === 'GET'/);
  assert.match(serverSource, /AGENT_CAPABILITY_REGISTRY\.report\(\)/);
  assert.doesNotMatch(serverSource, /pathname === '\/api\/capabilities'[\s\S]{0,500}(POST|PUT|DELETE)/);
});
~~~

- [ ] **Step 2: 运行集成失败测试**

Run:

~~~powershell
node --test server-verified-dispatch.test.js
~~~

Expected: the two new tests fail because server.js has not imported or used the Registry yet; the existing three tests remain passing.

- [ ] **Step 3: 添加 Registry 导入和能力定义辅助函数**

在 server.js 现有 verified-dispatch 相关 require 附近加入：

~~~js
const { createCapabilityRegistry } = require('./lib/capability-layer');
~~~

在 const ADAPTERS = [...] 后加入以下定义。它显式保留未支持能力，不把已有启动入口误报为已验证的 Session Activator：

~~~js
function unsupportedCapability(reason) {
  return {
    supported: false,
    implementation: null,
    source: 'unavailable',
    reason,
  };
}

function readerCapability(adapter) {
  const supported = typeof adapter.scanAll === 'function' && typeof adapter.poll === 'function';
  return supported
    ? { supported: true, implementation: adapter, source: 'adapter' }
    : unsupportedCapability('Adapter 没有完整的 scanAll/poll Conversation Reader');
}

function completionCapability(adapter) {
  const methods = [
    'parseLines',
    'parseSessionRows',
    'parseSessionStatus',
    'checkDesktopIdle',
    'isDeepSeekIdleComplete',
    'scanHeartbeats',
    'scanSessionStatuses',
  ].filter((name) => typeof adapter[name] === 'function');
  return methods.length
    ? { supported: true, implementation: adapter, source: 'adapter', methods }
    : unsupportedCapability('Adapter 尚未暴露独立的 Completion Detector 入口');
}

const VERIFIED_CAPABILITY_BINDINGS = {
  codex() {
    const writer = createCodexWriter();
    const delivery = createCodexDeliveryReader();
    return {
      sessionActivator: { supported: true, implementation: activateVerifiedSession, source: 'deep-link' },
      identityVerifier: { supported: true, implementation: verifyCodexDesktopSession, source: 'uia' },
      messageWriter: {
        supported: true,
        implementation: {
          write: writer.write,
          send: writer.send,
          verifyDraft: verifyCodexDraft,
        },
        source: 'uia',
      },
      deliveryVerifier: { supported: true, implementation: delivery, source: 'delivery-reader' },
    };
  },
  hermes() {
    const writer = createHermesWriter();
    const delivery = createHermesDeliveryReader();
    return {
      sessionActivator: { supported: true, implementation: activateVerifiedSession, source: 'deep-link' },
      identityVerifier: { supported: true, implementation: verifyHermesDesktopSession, source: 'uia' },
      messageWriter: {
        supported: true,
        implementation: {
          write: writer.write,
          send: writer.send,
          verifyDraft: verifyHermesDraft,
        },
        source: 'uia',
      },
      deliveryVerifier: { supported: true, implementation: delivery, source: 'delivery-reader' },
    };
  },
};

function capabilityDefinitionsForAdapter(adapter) {
  const unsupported = unsupportedCapability('Slice 1 尚未为 ' + adapter.ID + ' 接入该能力');
  const definitions = {
    sessionLocator: { supported: true, implementation: resolveVerifiedSession, source: 'core' },
    sessionActivator: unsupported,
    conversationReader: readerCapability(adapter),
    identityVerifier: unsupported,
    messageWriter: unsupported,
    deliveryVerifier: unsupported,
    completionDetector: completionCapability(adapter),
  };
  const bindingFactory = VERIFIED_CAPABILITY_BINDINGS[adapter.ID];
  return bindingFactory ? { ...definitions, ...bindingFactory() } : definitions;
}

const AGENT_CAPABILITY_REGISTRY = createCapabilityRegistry(
  ADAPTERS.map((adapter) => ({
    agentId: adapter.ID,
    capabilities: capabilityDefinitionsForAdapter(adapter),
  })),
);
~~~

- [ ] **Step 4: 让 Verified Dispatch 只从 Registry 组装依赖**

将当前 createVerifiedDispatchDependencies 函数整体替换为：

~~~js
function createVerifiedDispatchDependencies(agent) {
  const set = AGENT_CAPABILITY_REGISTRY.get(agent);
  if (!set) return null;

  const required = [
    'sessionLocator',
    'sessionActivator',
    'identityVerifier',
    'messageWriter',
    'deliveryVerifier',
  ].map((name) => set.get(name));
  if (required.some((capability) => !capability || !capability.supported)) return null;

  const locator = set.get('sessionLocator').implementation;
  const activator = set.get('sessionActivator').implementation;
  const verifier = set.get('identityVerifier').implementation;
  const writer = set.get('messageWriter').implementation;
  const delivery = set.get('deliveryVerifier').implementation;
  return {
    resolveSession: locator,
    verifySession: verifier,
    activateSession: activator,
    captureDeliverySnapshot: (target) => delivery.snapshot(target),
    writer,
    verifyDraft: (target, message) => writer.verifyDraft(target, message),
    verifyDelivery: (target, message, context) => delivery.verify(target, message, context),
  };
}
~~~

- [ ] **Step 5: 添加只读能力报告路由**

在 server.js 的 /api/health 路由后加入：

~~~js
  if (pathname === '/api/capabilities' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: AGENT_CAPABILITY_REGISTRY.report() }));
    return;
  }
~~~

此路由只返回 agentId、supported、source 和 reason，不返回函数、会话正文、令牌或 UIA 脚本。

- [ ] **Step 6: 运行服务端和 Slice 0 集成测试**

Run:

~~~powershell
node --test server-verified-dispatch.test.js lib/verified-dispatch.test.js lib/codex-desktop-uia.test.js lib/hermes-desktop-uia.test.js lib/codex-delivery.test.js lib/hermes-delivery.test.js
~~~

Expected: all existing and new tests pass; Verified Dispatch 的阶段顺序、单次 SEND、Draft Verify 和 reconciliation 行为不变。

- [ ] **Step 7: 检查改动并提交服务端接线**

Run:

~~~powershell
git diff --check
git diff --stat
git add -- server.js server-verified-dispatch.test.js
git commit -m "feat: route verified dispatch through capabilities"
~~~

Expected: staged files 只有 server.js 和 server-verified-dispatch.test.js，不包含任何 dist-* 目录。

## Task 4: 全量验证和交付检查

**Files:**

- Verify: lib/capability-layer.js
- Verify: lib/capability-layer.test.js
- Verify: server.js
- Verify: server-verified-dispatch.test.js

- [ ] **Step 1: 运行语法检查**

~~~powershell
node --check lib/capability-layer.js
node --check server.js
~~~

Expected: 两条命令均以退出码 0 结束。

- [ ] **Step 2: 运行 Slice 1 与 Slice 0 定向测试**

~~~powershell
node --test lib/capability-layer.test.js lib/verified-dispatch.test.js lib/codex-desktop-uia.test.js lib/hermes-desktop-uia.test.js lib/codex-delivery.test.js lib/hermes-delivery.test.js server-verified-dispatch.test.js
~~~

Expected: 所有测试通过，且没有失败或取消。

- [ ] **Step 3: 运行全量回归测试**

~~~powershell
node --test
~~~

Expected: 退出码 0，失败数为 0；记录实际 pass 数，不使用历史文档中的旧数字替代本次结果。

- [ ] **Step 4: 做最终范围检查**

~~~powershell
git status --short --branch
git diff HEAD~2..HEAD --stat
git diff HEAD~2..HEAD --name-only
~~~

Expected：

- 当前仍在 main。
- 只包含规格、计划、Capability Layer 和服务端接线相关提交。
- 所有原有 dist-* 未跟踪目录保持未提交。
- 没有 Model Router、Supervisor、Settings、数据库 schema 或自动重试改动。
