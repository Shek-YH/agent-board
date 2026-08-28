const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { assignSound, deleteSound, loadSoundSettings, setSoundEnabled, setSoundsEnabled, uploadSound } = require('./sound-settings');

function createPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-sounds-'));
  return { root, settingsPath: path.join(root, 'sound-settings.json'), uploadDir: path.join(root, 'uploads') };
}

const WAV_DATA_URL = `data:audio/wav;base64,${Buffer.from('RIFFtestWAVE', 'ascii').toString('base64')}`;

test('缺失或损坏的声音设置返回空声音库', () => {
  const paths = createPaths();
  try {
    assert.deepEqual(loadSoundSettings(paths), { assignments: {}, sounds: [] });
    fs.writeFileSync(paths.settingsPath, '{bad-json', 'utf8');
    assert.deepEqual(loadSoundSettings(paths), { assignments: {}, sounds: [] });
  } finally {
    fs.rmSync(paths.root, { force: true, recursive: true });
  }
});

test('上传音频会原子持久化到声音库并生成同源 URL', () => {
  const paths = createPaths();
  try {
    const sound = uploadSound({ dataUrl: WAV_DATA_URL, name: '完成 <提示>.wav' }, paths);
    const settings = loadSoundSettings(paths);

    assert.match(sound.id, /^[a-f0-9-]{36}$/);
    assert.equal(sound.mime, 'audio/wav');
    assert.match(sound.url, /^\/sounds\/uploads\/[a-f0-9-]+\.wav$/);
    assert.equal(fs.existsSync(path.join(paths.uploadDir, path.basename(sound.url))), true);
    assert.deepEqual(settings.sounds, [sound]);
    assert.equal(sound.name.includes('<'), false);
  } finally {
    fs.rmSync(paths.root, { force: true, recursive: true });
  }
});

test('拒绝非音频、非规范编码和超过大小限制的上传', () => {
  const paths = createPaths();
  try {
    assert.throws(() => uploadSound({ dataUrl: 'data:text/plain;base64,aGVsbG8=', name: 'x' }, paths), /unsupported audio/i);
    assert.throws(() => uploadSound({ dataUrl: 'data:audio/wav;base64,AB==', name: 'x' }, paths), /invalid audio/i);
    const huge = Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64');
    assert.throws(() => uploadSound({ dataUrl: `data:audio/wav;base64,${huge}`, name: 'x' }, paths), /too large/i);
  } finally {
    fs.rmSync(paths.root, { force: true, recursive: true });
  }
});

test('每个 Agent 只能选择声音库中的声音或关闭提示音', () => {
  const paths = createPaths();
  try {
    const sound = uploadSound({ dataUrl: WAV_DATA_URL, name: '完成.wav' }, paths);
    assert.equal(assignSound('codex', sound.id, paths).assignments.codex, sound.id);
    assert.equal(assignSound('codex', '', paths).assignments.codex, undefined);
    assert.throws(() => assignSound('codex', 'missing', paths), /sound not found/i);
  } finally {
    fs.rmSync(paths.root, { force: true, recursive: true });
  }
});

test('单个和批量开关保留声音绑定并持久化禁用状态', () => {
  const paths = createPaths();
  try {
    const sound = uploadSound({ dataUrl: WAV_DATA_URL, name: '完成.wav' }, paths);
    assignSound('codex', sound.id, paths);
    assignSound('claude', sound.id, paths);

    const disabledOne = setSoundEnabled('codex', false, paths);
    assert.deepEqual(disabledOne.disabledAgents, ['codex']);
    assert.equal(disabledOne.assignments.codex, sound.id);
    assert.deepEqual(loadSoundSettings(paths).disabledAgents, ['codex']);

    const disabledAll = setSoundsEnabled(['codex', 'claude'], false, paths);
    assert.deepEqual(disabledAll.disabledAgents, ['claude', 'codex']);
    assert.equal(disabledAll.assignments.claude, sound.id);

    const enabledAll = setSoundsEnabled(['codex', 'claude'], true, paths);
    assert.equal(enabledAll.disabledAgents, undefined);
    assert.equal(enabledAll.assignments.codex, sound.id);
    assert.equal(enabledAll.assignments.claude, sound.id);
  } finally {
    fs.rmSync(paths.root, { force: true, recursive: true });
  }
});

test('删除声音会移除音频文件、声音记录以及相关 Agent 绑定', () => {
  const paths = createPaths();
  try {
    const deleted = uploadSound({ dataUrl: WAV_DATA_URL, name: '待删除.wav' }, paths);
    const retained = uploadSound({ dataUrl: WAV_DATA_URL, name: '保留.wav' }, paths);
    assignSound('codex', deleted.id, paths);
    assignSound('claude', deleted.id, paths);
    assignSound('workbuddy', retained.id, paths);

    const settings = deleteSound(deleted.id, paths);

    assert.deepEqual(settings.sounds, [retained]);
    assert.equal(settings.assignments.codex, undefined);
    assert.equal(settings.assignments.claude, undefined);
    assert.equal(settings.assignments.workbuddy, retained.id);
    assert.equal(fs.existsSync(path.join(paths.uploadDir, path.basename(deleted.url))), false);
    assert.throws(() => deleteSound(deleted.id, paths), /sound not found/i);
  } finally {
    fs.rmSync(paths.root, { force: true, recursive: true });
  }
});
