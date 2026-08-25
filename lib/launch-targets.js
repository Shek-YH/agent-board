'use strict';

const path = require('node:path');

function unavailable(label, detail) {
  return { available: false, kind: 'path', label, detail };
}

function targetDetail(value) {
  const text = String(value || '');
  if (/^[A-Za-z]:[\\/]/.test(text)) return path.win32.basename(text);
  return text;
}

function normalizeTarget(spec, label) {
  if (!spec || spec.available === false || !spec.value) {
    return unavailable(label, label === 'CLI' ? '未找到 CLI' : '未找到桌面端');
  }
  return {
    available: true,
    kind: spec.kind || 'command',
    value: String(spec.value),
    label: spec.label || label,
    detail: spec.detail || targetDetail(spec.value),
  };
}

function buildLaunchTargets({ defs = {}, probes = {}, desktop = {} } = {}) {
  const out = {};
  for (const id of Object.keys(defs)) {
    const probe = probes[id] || {};
    const cli = probe.tier === 'cli' && probe.installed && probe.path
      ? normalizeTarget({ kind: 'path', value: probe.path }, 'CLI')
      : unavailable('CLI', '未找到 CLI');
    out[id] = {
      cli,
      desktop: normalizeTarget(desktop[id], '桌面端'),
    };
  }
  return out;
}

function selectLaunchTarget(targets, agent, target) {
  if (target !== 'cli' && target !== 'desktop') {
    throw new Error('不支持的启动方式');
  }
  const selected = targets && targets[agent] && targets[agent][target];
  if (!selected || selected.available !== true) {
    throw new Error(`${agent} 的${target === 'cli' ? ' CLI' : '桌面端'}目标不可用`);
  }
  return selected;
}

function resolveLaunchRequest({ manual, requested = '' } = {}) {
  const override = manual?.manualDesktop;
  if (override?.enabled === true && typeof override.target === 'string' && override.target.trim()) {
    return { kind: 'manual', target: override.target.trim() };
  }
  return { kind: 'automatic', target: requested };
}

module.exports = { buildLaunchTargets, selectLaunchTarget, resolveLaunchRequest };
