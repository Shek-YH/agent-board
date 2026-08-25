'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLaunchTargets, selectLaunchTarget } = require('./launch-targets');

test('buildLaunchTargets 把探测到的 CLI 路径变成可点击目标', () => {
  const result = buildLaunchTargets({
    defs: { pi: { name: 'Pi Agent' } },
    probes: { pi: { installed: true, tier: 'cli', path: 'C:\\tools\\pi.cmd' } },
    desktop: { pi: { kind: 'path', available: true, value: 'C:\\Pi\\Pi.exe', detail: 'Pi.exe' } },
  });
  assert.deepEqual(result.pi.cli, {
    available: true, kind: 'path', value: 'C:\\tools\\pi.cmd', label: 'CLI', detail: 'pi.cmd',
  });
  assert.equal(result.pi.desktop.available, true);
});

test('buildLaunchTargets 对未命中的一端返回不可用目标，不影响另一端', () => {
  const result = buildLaunchTargets({
    defs: { codex: { name: 'Codex' } }, probes: { codex: { installed: false } },
    desktop: { codex: { kind: 'scheme', available: true, value: 'codex://', detail: 'codex:// 协议' } },
  });
  assert.equal(result.codex.cli.available, false);
  assert.equal(result.codex.desktop.available, true);
});

test('selectLaunchTarget 只允许 available 的 cli/desktop 目标', () => {
  const targets = { pi: { cli: { available: true, value: 'pi.cmd' }, desktop: { available: false } } };
  assert.equal(selectLaunchTarget(targets, 'pi', 'cli').value, 'pi.cmd');
  assert.throws(() => selectLaunchTarget(targets, 'pi', 'desktop'), /不可用/);
  assert.throws(() => selectLaunchTarget(targets, 'pi', 'other'), /启动方式/);
});
