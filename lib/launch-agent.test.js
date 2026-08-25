'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLaunchRequest } = require('./launch-targets');

test('手动桌面端启用时，自动 CLI/桌面请求都被手动目标覆盖', () => {
  const manual = { manualDesktop: { enabled: true, target: 'C:\\Hermes\\Hermes.exe' } };
  assert.deepEqual(resolveLaunchRequest({ manual, requested: 'cli' }), {
    kind: 'manual', target: 'C:\\Hermes\\Hermes.exe',
  });
  assert.deepEqual(resolveLaunchRequest({ manual, requested: 'desktop' }), {
    kind: 'manual', target: 'C:\\Hermes\\Hermes.exe',
  });
});

test('手动关闭时恢复请求的自动目标', () => {
  assert.deepEqual(resolveLaunchRequest({
    manual: { manualDesktop: { enabled: false, target: 'Hermes.exe' } },
    requested: 'cli',
  }), { kind: 'automatic', target: 'cli' });
});
