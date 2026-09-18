'use strict';
// 看板卡片「数据就绪」语义回归测试。
//
// 防御的历史缺陷：会话尚在被增量读入时，卡片就把「还没读到」渲染成
// 「（无项目路径）」「1 条」「（暂无用户指令）」，与真实会话状态自相矛盾；
// 此时点击跳转还会因为身份未落定而报「无效的会话 ID」。
//
// 本测试锁定 store 层的三件事：
//   1. 新会话在读到第一条真实消息前 is_read_complete === false
//   2. 读到真实消息后翻 true，且 project / msg_count 随即可用
//   3. heartbeat / title 这类元消息不算「真实消息」，不得把卡片置为就绪
//
// 用法：node --test board-readiness.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshStoreDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ab-readiness-'));
}

function purgeStoreCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}lib${path.sep}`) || key.endsWith('store.js')) delete require.cache[key];
  }
}

function freshStore() {
  process.env.AB_DATA_DIR = freshStoreDir();
  purgeStoreCache();
  return require('./lib/store');
}

function reloadStore() {
  purgeStoreCache();
  return require('./lib/store');
}

test('未读到真实消息前，卡片标记为数据未就绪', () => {
  const store = freshStore();
  const ref = 'deepseek:session-meta-only';
  store.ingest({ agent: 'deepseek', sessionId: 'session-meta-only', sourceId: 'h:1', ts: Date.now(), role: '', kind: 'heartbeat', text: '' });

  const card = store.getSessions({ agent: 'deepseek' }).find((s) => s.id === ref);
  assert.ok(card, '仅有 heartbeat 时也应有会话条目');
  assert.equal(card.is_read_complete, false, 'heartbeat 不得把卡片置为已就绪');
  assert.equal(card.msg_count, 0, 'heartbeat 不计入消息数');
});

test('读到真实消息后，卡片转为已就绪并带上 project / msg_count', () => {
  const store = freshStore();
  const ref = 'deepseek:session-real';
  const ts = Date.now();
  store.ingest({ agent: 'deepseek', sessionId: 'session-real', sourceId: 'u:0', ts, role: 'user', kind: 'message', text: '不能下载抖音视频吗', project: 'F:\\CCPJ\\VideoDL' });

  const card = store.getSessions({ agent: 'deepseek' }).find((s) => s.id === ref);
  assert.equal(card.is_read_complete, true);
  assert.equal(card.msg_count, 1);
  assert.equal(card.project, 'F:\\CCPJ\\VideoDL');
  assert.equal(card.last_user_text, '不能下载抖音视频吗');
});

test('title 元消息不算真实消息', () => {
  const store = freshStore();
  const ref = 'deepseek:session-title-only';
  store.ingest({ agent: 'deepseek', sessionId: 'session-title-only', sourceId: 't:1', ts: Date.now(), role: '', kind: 'title', text: '会话标题', title: '会话标题' });

  const card = store.getSessions({ agent: 'deepseek' }).find((s) => s.id === ref);
  assert.equal(card.is_read_complete, false);
  assert.equal(card.title, '会话标题', 'title 消息仍应写入标题');
});

test('getSession 同样暴露 is_read_complete，供跳转前的权威补全使用', () => {
  const store = freshStore();
  const ref = 'deepseek:session-detail';
  assert.equal(store.getSession(ref), null, '不存在的会话返回 null');

  store.ingest({ agent: 'deepseek', sessionId: 'session-detail', sourceId: 'u:0', ts: Date.now(), role: 'user', kind: 'message', text: '排查会话状态显示不一致', project: 'F:\\CCPJ\\Cuecut6' });
  const detail = store.getSession(ref);
  assert.equal(detail.is_read_complete, true);
  assert.equal(detail.session_id, 'session-detail');
  assert.equal(detail.project, 'F:\\CCPJ\\Cuecut6');
});

test('repairUserQueries 重建后仍需保持就绪语义一致', () => {
  const store = freshStore();
  const ts = Date.now();
  store.ingest({ agent: 'deepseek', sessionId: 'session-a', sourceId: 'u:0', ts, role: 'user', kind: 'message', text: '第一句', project: 'P' });
  store.ingest({ agent: 'deepseek', sessionId: 'session-a', sourceId: 'u:1', ts: ts + 1000, role: 'user', kind: 'message', text: '最后一句', project: 'P' });
  store.repairUserQueries();

  const card = store.getSessions({ agent: 'deepseek' }).find((s) => s.id === 'deepseek:session-a');
  assert.equal(card.is_read_complete, true, 'repair 后不得丢失就绪标记');
  assert.equal(card.last_user_text, '最后一句');
});

test('从磁盘快照加载后，历史会话仍判定为已就绪', () => {
  // 回归背景：就绪标记若只写在内存，重启后 scanAll 会因 mtime 未变而跳过旧文件，
  // 标记永远补不回来 → 全站卡片都退化成「数据读取中」。因此判定必须能从
  // 已加载的 messages 索引推导出来。
  const dir = freshStoreDir();
  process.env.AB_DATA_DIR = dir;
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({
    sessions: [{ id: 'deepseek:session-loaded', agent: 'deepseek', session_id: 'session-loaded', project: 'F:\\CCPJ\\Cuecut6', title: '历史会话', first_seen: 1, last_seen: 2, msg_count: 2 }],
    messages: [
      { agent: 'deepseek', source_id: 'h:0', session_ref: 'deepseek:session-loaded', ts: 1, role: '', kind: 'heartbeat', text: '' },
      { agent: 'deepseek', source_id: 'u:0', session_ref: 'deepseek:session-loaded', ts: 2, role: 'user', kind: 'message', text: '导出的webm文件不是透明背景，有办法解决吗' },
    ],
    meta: [], hidden: [],
  }), 'utf8');

  const store = reloadStore();
  const card = store.getSessions({ agent: 'deepseek' }).find((s) => s.id === 'deepseek:session-loaded');
  assert.ok(card, '历史会话应被加载');
  assert.equal(card.is_read_complete, true, '加载后必须判定为已就绪，否则全站卡片会显示「读取中」');
});

test('仅有 heartbeat/title 的已加载会话仍判定为未就绪', () => {
  const dir = freshStoreDir();
  process.env.AB_DATA_DIR = dir;
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({
    sessions: [{ id: 'deepseek:session-meta', agent: 'deepseek', session_id: 'session-meta', project: '', title: '', first_seen: 1, last_seen: 2, msg_count: 0 }],
    messages: [
      { agent: 'deepseek', source_id: 'h:0', session_ref: 'deepseek:session-meta', ts: 1, role: '', kind: 'heartbeat', text: '' },
      { agent: 'deepseek', source_id: 't:0', session_ref: 'deepseek:session-meta', ts: 2, role: '', kind: 'title', text: '标题' },
    ],
    meta: [], hidden: [],
  }), 'utf8');

  const store = reloadStore();
  const card = store.getSessions({ agent: 'deepseek' }).find((s) => s.id === 'deepseek:session-meta');
  assert.ok(card);
  assert.equal(card.is_read_complete, false, '元消息不算真实内容，仍应显示「读取中」');
});
