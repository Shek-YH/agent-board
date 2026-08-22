'use strict';
// DeepSeek Harness 适配器：解析 ~/.dsh/sessions/<workspace>/session-<uuid>/session.jsonl.zstd
// DeepSeek Harness 把每次会话存为 zstd 压缩的 JSONL，通过 Python zstandard 解压后读取。
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { collectFiles, fileMtime } = require('../watcher');

const ID = 'deepseek';
const ROOT = path.join(os.homedir(), '.dsh', 'sessions');

// 优先使用管理好的 Python venv（已安装 zstandard），可通过环境变量覆盖
const PYTHON = process.env.AGENTBOARD_PYTHON ||
  path.join(os.homedir(), '.workbuddy', 'binaries', 'python', 'envs', 'default', 'Scripts', 'python.exe');
const DECOMPRESSOR = path.join(__dirname, '..', 'decompress-zstd.py');

function isSessionFile(p) { return p.endsWith('.jsonl.zstd'); }

function fileToSessionId(file) {
  // 文件目录：.../session-<uuid>/session.jsonl.zstd
  return path.basename(path.dirname(file));
}

function extractText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    // 只取纯文本结果；reasoning / tool-call 属于中间过程，不展示
    if (c.type === 'text' && c.text) parts.push(c.text);
  }
  return parts.join('\n').trim();
}

function decompress(file) {
  try {
    const r = spawnSync(PYTHON, [DECOMPRESSOR, file], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30000,
      windowsHide: true,
    });
    if (r.error || r.status !== 0) {
      console.error(`[${ID}] decompress failed for ${file}:`, r.stderr || r.error?.message || 'unknown');
      return '';
    }
    return r.stdout || '';
  } catch (e) {
    console.error(`[${ID}] decompress exception for ${file}:`, e.message);
    return '';
  }
}

// 全量读取：DeepSeek Harness 的 session.jsonl.zstd 是「整体重写」而非追加——
// 每次消息都会把整个会话重新压缩写回。行号 offset 增量在文件重写后失效：
// 一旦重写后的行数 < 上次记录的 offset，tailRead 从过大的行号开始会一行都读不到，
// 且 newOffset 被覆盖成新行数，从此永久漏读（表现为 deepseek 瀑布流显示不全，
// 直到 /api/rescan 重置 offset 才恢复）。
// 因此这里强制从 0 全量读：文件都很小（最大 ~200KB），且 store.ingest 按 source_id
// 幂等覆盖（重复读无副作用），配合 scanAll 的 mtime 缓存跳过未变化文件。
function tailRead(file, offset) {
  const text = decompress(file);
  if (!text) return { lines: [], newOffset: 0 };
  const allRaw = text.split('\n');
  const lines = [];
  for (let i = 0; i < allRaw.length; i++) {
    const ln = allRaw[i].trim();
    if (!ln) continue;
    try { lines.push(JSON.parse(ln)); } catch { /* 跳过坏行 */ }
  }
  return { lines, newOffset: allRaw.length };
}

function parseLines(lines) {
  const out = [];
  let project = '';
  let sessionId = '';
  let title = '';
  let titleSource = '';

  for (const line of lines) {
    if (!line || typeof line !== 'object') continue;
    try {
      const type = line.type;

      if (type === 'session') {
        project = line.cwd || '';
        sessionId = line.id || '';
        continue;
      }

      if (type === 'session/title' && line.data && line.data.title) {
        const src = (line.data.source && line.data.source.kind) || 'fallback';
        // provider 生成的标题优先于 fallback；同来源取后出现的
        if (src === 'provider' || titleSource !== 'provider') {
          title = String(line.data.title).trim();
          titleSource = src;
        }
        continue;
      }

      if (type === 'user/message' && line.data) {
        // 过滤系统提示 / plugin 注入的 user 消息，只保留真实用户输入
        const sourceKind = line.data.source && line.data.source.kind;
        if (sourceKind !== 'user') continue;
        const text = extractText(line.data.content);
        if (!text) continue;
        out.push({
          agent: ID,
          sourceId: line.seq != null ? `u:${line.seq}` : `u:${Math.random()}`,
          sessionId,
          ts: Number(line.time) || 0,
          role: 'user',
          kind: 'message',
          text,
          project,
        });
        continue;
      }

      if (type === 'assistant/message' && line.data && line.data.message) {
        const msg = line.data.message;
        const text = extractText(msg.content);
        if (!text) continue;
        out.push({
          agent: ID,
          sourceId: line.seq != null ? `a:${line.seq}` : `a:${Math.random()}`,
          sessionId,
          ts: Number(line.time) || 0,
          role: 'assistant',
          kind: 'message',
          text,
          project,
        });
        continue;
      }
    } catch { /* 跳过异常行 */ }
  }

  if (title && sessionId) {
    out.unshift({
      agent: ID,
      sourceId: `title:${sessionId}`,
      sessionId,
      ts: 0, // 标题不推高 last_seen
      role: 'system',
      kind: 'title',
      text: '',
      title,
      project,
    });
  }

  return out;
}

// 探测/安装配置。命令取自 EchoBird 官方安装定义 docs/api/tools/install/dsh.json，
// 路径列表取自其 tools/dsh/paths.json。注意：这里的 agent id 是 'deepseek'（历史命名，
// 沿用现有 ADAPTERS 里的用法），但 CLI 命令和 npm 包名都是 dsh / @deepseek-ai/dsh。
const detect = {
  tier: 'cli',
  identityGuard: {
    description: 'DeepSeek Harness（命令 dsh）是 DeepSeek 官方开源的 agent runtime，developer preview 阶段',
    notToConfuseWith: [],
  },
  requirements: { node: '>=22.19' },
  probe: {
    kind: 'path',
    win32: ['%APPDATA%\\npm\\dsh.cmd', '%APPDATA%\\npm\\dsh'],
    darwin: ['/usr/local/bin/dsh', '/opt/homebrew/bin/dsh', '~/.npm-global/bin/dsh'],
    linux: ['/usr/local/bin/dsh', '/usr/bin/dsh', '~/.npm-global/bin/dsh', '~/.local/bin/dsh'],
  },
  install: {
    methods: [{ kind: 'npm', pkg: '@deepseek-ai/dsh' }],
    warning: 'developer preview，0.1.0-rc.x，可能有破坏性变更',
  },
  network: {
    testUrls: ['https://www.deepseek.com', 'https://github.com/deepseek-ai/deepseek-harness', 'https://registry.npmjs.org'],
    mirrors: {},
    blockedRegions: {},
  },
  verify: { cmd: 'dsh --version' },
  afterInstall: {
    tellUser: ['装完用 `dsh web` 启动本地服务，监听 127.0.0.1:3080，不会自动开浏览器', '只支持本地回环，暂不支持 --host 0.0.0.0'],
  },
};

module.exports = {
  ID, ROOT, isSessionFile, fileToSessionId, parseLines, tailRead, detect,
  readFile: tailRead,
  scanAll(store) {
    const files = collectFiles(ROOT, isSessionFile, 6);
    let count = 0;
    for (const f of files) {
      // mtime 缓存：文件未变化则跳过，避免每 30s 无谓解压（zstd 解压走 python 子进程，成本高）
      const mkey = `mtime:${ID}:${f}`;
      const last = Number(store.stmts.getMeta.get(mkey)?.v || 0);
      const cur = fileMtime(f);
      if (cur > 0 && cur <= last) continue;
      store.stmts.setMeta.run(mkey, String(cur));
      const { lines } = tailRead(f, 0); // zstd 整体重写，必须全量读（source_id 幂等）
      for (const m of parseLines(lines)) { store.ingest(m); count++; }
    }
    return count;
  },
  poll(store, changedPaths) {
    let count = 0;
    const files = changedPaths.filter(isSessionFile);
    for (const f of files) {
      const { lines } = tailRead(f, 0); // watch 触发 = 文件确实变化，直接全量读
      const msgs = parseLines(lines);
      for (const m of msgs) { store.ingest(m); count++; }
      // 活跃信号用当前时间：文件在写 = agent 在运行，避免消息间隔超过窗口导致状态闪烁
      if (msgs.length) {
        const last = msgs[msgs.length - 1];
        store.touchActive(`${ID}:${last.sessionId}`, { agent: ID, project: last.project }, Date.now());
      }
    }
    return count;
  },
};
