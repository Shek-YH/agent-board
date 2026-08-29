'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const settingsPath = path.join(__dirname, '..', 'public', 'sounds', 'sound-settings.json');
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const expected = {
  claude: 'claude龙安昀.mp3',
  codex: 'codex龙安昀.mp3',
  marvis: 'marvis龙安昀.mp3',
  zcode: 'zcode龙安昀.mp3',
  hermes: '赫秘书龙安昀.mp3',
  pi: '派龙安昀.mp3',
  deepseek: 'deepseek龙安昀.mp3',
  workbuddy: 'workbuddy龙安昀.mp3',
};

test('每个内置 agent 默认绑定对应的龙安昀音频', () => {
  for (const [agent, filename] of Object.entries(expected)) {
    const soundId = settings.assignments[agent];
    assert.ok(soundId, `${agent} should have a default sound assignment`);
    const sound = settings.sounds.find((item) => item.id === soundId);
    assert.ok(sound, `${agent} assignment should point to a sound record`);
    assert.equal(sound.name, filename);
    assert.equal(path.basename(sound.url), `${agent}-longanyun.mp3`);
    const localPath = path.join(__dirname, '..', 'public', sound.url.replace(/^\/sounds\//, 'sounds\\'));
    assert.equal(fs.existsSync(localPath), true, `${agent} runtime audio should exist`);
  }
});
