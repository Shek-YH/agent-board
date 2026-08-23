const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AUTH_CACHE_PATH,
  clearAuthCache,
  loadAuthCache,
  saveAuthCache,
} = require('./auth-cache');

function createCachePath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-auth-cache-'));
  return { directory, filePath: path.join(directory, 'nested', 'auth.json') };
}

test('默认缓存路径位于 LOCALAPPDATA 的 AgentBoard 目录', () => {
  assert.equal(path.basename(AUTH_CACHE_PATH), 'auth.json');
  assert.equal(path.basename(path.dirname(AUTH_CACHE_PATH)), 'AgentBoard');
});

test('不存在或损坏的缓存返回 null', () => {
  const { directory, filePath } = createCachePath();
  try {
    assert.equal(loadAuthCache(filePath), null);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{not-json', 'utf8');
    assert.equal(loadAuthCache(filePath), null);
    fs.writeFileSync(filePath, JSON.stringify({ token: '', receivedAt: 1 }), 'utf8');
    assert.equal(loadAuthCache(filePath), null);
    fs.writeFileSync(filePath, JSON.stringify({ token: 'token', receivedAt: 1, extra: true }), 'utf8');
    assert.equal(loadAuthCache(filePath), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('保存后可读取，并且不遗留临时文件', () => {
  const { directory, filePath } = createCachePath();
  const cache = { token: 'signed-token', receivedAt: 1_234 };
  try {
    saveAuthCache(cache, filePath);

    assert.deepEqual(loadAuthCache(filePath), cache);
    assert.equal(fs.existsSync(`${filePath}.tmp`), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('保存无效缓存抛错且不会创建文件', () => {
  const { directory, filePath } = createCachePath();
  try {
    assert.throws(() => saveAuthCache({ token: '', receivedAt: 1 }, filePath), /invalid auth cache/i);
    assert.throws(
      () => saveAuthCache({ token: 'token', receivedAt: 1, extra: true }, filePath),
      /invalid auth cache/i,
    );
    const inheritedCache = Object.create({ token: 'token', receivedAt: 1 });
    assert.throws(() => saveAuthCache(inheritedCache, filePath), /invalid auth cache/i);
    assert.equal(fs.existsSync(filePath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('原子替换失败时清理包含令牌的临时文件', () => {
  const { directory, filePath } = createCachePath();
  try {
    fs.mkdirSync(filePath, { recursive: true });

    assert.throws(
      () => saveAuthCache({ token: 'signed-token', receivedAt: 1 }, filePath),
      /EISDIR|EPERM|ENOTDIR/,
    );
    assert.deepEqual(fs.readdirSync(path.dirname(filePath)), ['auth.json']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('清除缓存可重复调用', () => {
  const { directory, filePath } = createCachePath();
  try {
    saveAuthCache({ token: 'signed-token', receivedAt: 1 }, filePath);
    clearAuthCache(filePath);
    clearAuthCache(filePath);

    assert.equal(loadAuthCache(filePath), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
