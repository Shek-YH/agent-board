'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8').replace(/\r\n/g, '\n');

test('verified dispatch route is present and only accepts the Slice 0 request fields', () => {
  assert.match(serverSource, /require\('\.\/lib\/verified-dispatch'\)/);
  assert.match(serverSource, /require\('\.\/lib\/codex-desktop-uia'\)/);
  assert.match(serverSource, /require\('\.\/lib\/hermes-desktop-uia'\)/);
  assert.match(serverSource, /require\('\.\/lib\/codex-delivery'\)/);
  assert.match(serverSource, /require\('\.\/lib\/hermes-delivery'\)/);
  assert.match(serverSource, /pathname === '\/api\/verified-dispatch' && req\.method === 'POST'/);
  assert.match(serverSource, /body\.agent/);
  assert.match(serverSource, /body\.project/);
  assert.match(serverSource, /body\.sessionRef/);
  assert.match(serverSource, /body\.message/);
  assert.match(serverSource, /dispatchVerifiedMessage\(/);
});

test('verified dispatch route delegates to strict resolution and reports reconciliation without retrying', () => {
  assert.match(serverSource, /store\.resolveSessionControlTarget\(/);
  assert.match(serverSource, /launchSchemeTargetPromise\(/);
  assert.match(serverSource, /launchHermesThenFocus\(/);
  assert.match(serverSource, /verifyCodexDesktopSession/);
  assert.match(serverSource, /verifyHermesDesktopSession/);
  assert.match(serverSource, /createCodexDeliveryReader/);
  assert.match(serverSource, /createHermesDeliveryReader/);
  assert.match(serverSource, /reconciliation_required/);
  assert.doesNotMatch(serverSource, /verified-dispatch[\s\S]{0,800}setTimeout\([^)]*retry/i);
});

test('verified dispatch route is scoped by the capability registry, including guarded headless Agents', () => {
  const routeStart = serverSource.indexOf("pathname === '/api/verified-dispatch'");
  assert.ok(routeStart >= 0);
  const routeEnd = serverSource.indexOf("\n  // 按 threadId 打开指定 Codex 会话", routeStart);
  const route = serverSource.slice(routeStart, routeEnd >= 0 ? routeEnd : routeStart + 9000);
  assert.match(route, /createVerifiedDispatchDependencies/);
  assert.match(route, /!request\.sessionRef && !request\.project/);
  const factoryStart = serverSource.indexOf('function createVerifiedDispatchDependencies');
  const factoryEnd = serverSource.indexOf('\nfunction verifiedDispatchHttpStatus', factoryStart);
  const dependencyFactory = serverSource.slice(factoryStart, factoryEnd);
  assert.match(dependencyFactory, /AGENT_CAPABILITY_REGISTRY\.get\(agent\)/);
  assert.match(serverSource, /AGENT_BOARD_HEADLESS_EXECUTION/);
  assert.match(serverSource, /createHeadlessCapabilityBinding/);
  assert.match(dependencyFactory, /prepareSession/);
  assert.doesNotMatch(dependencyFactory, /if \(agent === 'codex'\)/);
  assert.doesNotMatch(dependencyFactory, /if \(agent === 'hermes'\)/);
  assert.doesNotMatch(route, /model/);
  assert.doesNotMatch(route, /retry/i);
});

test('production routing receives the Hermes adapter capability declaration', () => {
  assert.match(serverSource, /routingAgentCapabilities:\s*\{\s*hermes:\s*hermes\.createRoutingCapability\(\)/);
});

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
  assert.match(serverSource, /adapterVersion/);
  assert.match(serverSource, /supportedAppVersionRange/);
  assert.match(serverSource, /selectorProfileVersion/);
  assert.match(serverSource, /lastProbeResult/);
  assert.match(serverSource, /modelCatalogProbeAt/);
  assert.doesNotMatch(serverSource, /pathname === '\/api\/capabilities'[\s\S]{0,500}(POST|PUT|DELETE)/);
});
