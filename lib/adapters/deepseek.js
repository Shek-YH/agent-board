'use strict';
// DeepSeek Harness 适配器：解析 ~/.dsh/sessions/<workspace>/session-<uuid>/session.jsonl.zstd
// DeepSeek Harness 把每次会话存为 zstd 压缩的 JSONL，通过 Node 内置 zstd 能力解压后读取。
const path = require('path');
const os = require('os');
const fs = require('fs');
const { zstdDecompressSync } = require('node:zlib');
const { collectFiles, fileMtime } = require('../watcher');

const ID = 'deepseek';
const ROOT = path.join(os.homedir(), '.dsh', 'sessions');
const ZSTD_FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// DeepSeek Desktop 的 session.jsonl.zstd 有明确的 turn/end 终态；下面的空闲阈值
// 只作为旧文件/异常文件没有 turn/end 时的兼容兜底，不参与正常会话的完成延迟。
const DEEPSEEK_IDLE_MS = 40 * 1000;
const DEEPSEEK_FRESH_MS = 30 * 1000;
const DEEPSEEK_DEBOUNCE_MS = 20 * 1000;
const deepseekIdleSince = new Map();

function isSessionFile(p) { return p.endsWith('.jsonl.zstd'); }

function fileOffsetKey(filePath) {
  return `offset:topology-v3:${ID}:${filePath}`;
}

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

function topologyForSession(lines = []) {
  const header = lines.find((line) => line && line.type === 'session') || {};
  const parentSessionId = String(header.parentSession || '').trim();
  // The event type is itself an explicit durable identity signal. A parent is
  // still required so a descriptor from a partial artifact cannot create an
  // orphan child.
  const hasDescriptor = lines.some((line) => line && line.type === 'subagent/descriptor');
  const hasChildEvidence = header.origin === 'subagent' || hasDescriptor;
  if (parentSessionId && hasChildEvidence) {
    return {
      sessionRole: 'child',
      parentSessionId,
      rootSessionId: parentSessionId,
      topologySource: 'explicit',
      topologyConfidence: 1,
      childDetection: 'verified',
      controlEligibility: 'blocked',
    };
  }
  return {
    sessionRole: 'main',
    topologySource: 'explicit',
    topologyConfidence: 1,
    childDetection: 'verified',
    controlEligibility: 'eligible',
  };
}

function decompress(file) {
  try {
    const compressed = fs.readFileSync(file);
    const frameStarts = [];
    for (let offset = 0; ; ) {
      const next = compressed.indexOf(ZSTD_FRAME_MAGIC, offset);
      if (next < 0) break;
      frameStarts.push(next);
      offset = next + ZSTD_FRAME_MAGIC.length;
    }
    if (frameStarts.length <= 1) return zstdDecompressSync(compressed).toString('utf8');

    // DeepSeek Desktop 会把 session.jsonl.zstd 写成连续的独立 zstd 帧。
    // Node 的一次性解压 API 默认只返回第一帧，因此逐帧解压后再拼回 JSONL。
    const chunks = [];
    for (let frame = 0; frame < frameStarts.length; ) {
      let decoded = null;
      let nextFrame = frame + 1;
      while (nextFrame <= frameStarts.length) {
        const end = nextFrame < frameStarts.length ? frameStarts[nextFrame] : compressed.length;
        try {
          decoded = zstdDecompressSync(compressed.subarray(frameStarts[frame], end));
          break;
        } catch {
          nextFrame++;
        }
      }
      if (!decoded) throw new Error('无法解压 DeepSeek zstd 帧');
      chunks.push(decoded);
      frame = nextFrame;
    }
    return Buffer.concat(chunks).toString('utf8');
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
  const topology = topologyForSession(lines);
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

      // DeepSeek Harness 在每轮结束时写入明确的 turn/end 事件：
      // data.reason.kind=completed/aborted。它是会话状态的权威来源，
      // 不能只看最后一条 assistant 消息和文件 mtime。
      if (type === 'turn/end' && line.data) {
        const reasonKind = line.data.reason && line.data.reason.kind;
        if (sessionId && reasonKind) {
          out.push({
            agent: ID,
            sourceId: line.seq != null ? `turnend:${line.seq}` : `turnend:${line.time || out.length}`,
            sessionId,
            ts: Number(line.time) || 0,
            kind: 'turn_end',
            turnStatus: String(reasonKind),
            project,
            ...topology,
          });
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
          ...topology,
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
          ...topology,
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
      ...topology,
    });
  }

  return out;
}

function isDeepSeekIdleComplete(lastRole, idleMs) {
  return lastRole === 'assistant' && idleMs > DEEPSEEK_IDLE_MS;
}

// DeepSeek 进程本身会长期打开桌面窗口，不能用进程是否存在判断某一张卡是否完成。
// 这里仅为没有 turn/end 的旧格式保留「文件静止 + 最后一条真实消息角色」兜底。
function checkDesktopIdle(store) {
  if (!fs.existsSync(ROOT)) return;
  const now = Date.now();
  let files;
  try { files = collectFiles(ROOT, isSessionFile, 6); } catch { return; }

  for (const f of files) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    const ref = `${ID}:${fileToSessionId(f)}`;
    const idle = Math.max(0, now - st.mtimeMs);
    let lastRole = store.getLastRole(ref);

    // 服务重启后 store 可能只有持久化消息索引、尚未被本轮扫描重建角色；
    // 只对这种缺失情况补读一次文件，避免把正常的 user 回合误判为完成。
    if (!lastRole) {
      const { lines } = tailRead(f, 0);
      const msgs = parseLines(lines).filter((m) => m.kind === 'message');
      lastRole = msgs.length ? msgs[msgs.length - 1].role : null;
    }

    if (idle < DEEPSEEK_FRESH_MS) {
      // 文件刚写入 = agent 仍在运行；也允许已完成后重新发起新一轮。
      store.setAgentActive(ref, true, now);
      deepseekIdleSince.delete(ref);
      continue;
    }

    if (!isDeepSeekIdleComplete(lastRole, idle)) {
      deepseekIdleSince.delete(ref);
      continue;
    }

    const first = deepseekIdleSince.get(ref) || now;
    deepseekIdleSince.set(ref, first);
    if (now - first >= DEEPSEEK_DEBOUNCE_MS) {
      store.setAgentActive(ref, false, now);
    }
  }
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
    executable: true,
    command: 'dsh',
    win32: [
      '%APPDATA%\\npm\\dsh.cmd',
      '%APPDATA%\\npm\\dsh',
      '%USERPROFILE%\\.workbuddy\\binaries\\node\\versions\\*\\dsh.cmd',
    ],
    darwin: ['/usr/local/bin/dsh', '/opt/homebrew/bin/dsh', '~/.npm-global/bin/dsh'],
    linux: ['/usr/local/bin/dsh', '/usr/bin/dsh', '~/.npm-global/bin/dsh', '~/.local/bin/dsh'],
  },
  // DSH Desktop 与 dsh CLI 是两个不同变体。桌面端不执行 dsh --version，
  // 仅作为 GUI 启动和自动配置路径的候选。
  desktopProbe: {
    probe: {
      kind: 'path',
      executable: true,
      win32: [
        '%LOCALAPPDATA%\\Programs\\DSH Desktop\\DSH Desktop.exe',
        '%LOCALAPPDATA%\\DSH Desktop\\DSH Desktop.exe',
        '%LOCALAPPDATA%\\DeepSeek Harness\\DeepSeek Harness.exe',
        'D:\\deepseek\\DSH Desktop\\DSH Desktop.exe',
      ],
      darwin: [
        '/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop',
        '~/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop',
        '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
      ],
      registryHints: {
        windowsDisplayNamePrefixes: ['DSH Desktop', 'DeepSeek Harness'],
      },
      executableNames: ['DSH Desktop.exe', 'DeepSeek Harness.exe'],
    },
  },
  install: {
    methods: [
      { kind: 'download', url: 'https://www.deepseek.com/harness/en/' },
    ],
    warning: '请在 DeepSeek Harness 官方页面完成安装；Agent Board 不会执行第三方安装命令',
  },
  network: {
    testUrls: ['https://www.deepseek.com', 'https://github.com/deepseek-ai/deepseek-harness', 'https://registry.npmjs.org'],
    mirrors: {},
    blockedRegions: {},
  },
  verify: { cmd: 'dsh --version' },
  afterInstall: {
    tellUser: ['装完用 `dsh web` 启动本地服务，监听 127.0.0.1:3080，默认会自动打开浏览器（可用 --no-open 关掉）', '只支持本地回环，暂不支持 --host 0.0.0.0'],
  },
};

module.exports = {
  ID, ROOT, isSessionFile, fileToSessionId, parseLines, topologyForSession, tailRead, fileOffsetKey, detect,
  DEEPSEEK_IDLE_MS, DEEPSEEK_FRESH_MS, DEEPSEEK_DEBOUNCE_MS,
  isDeepSeekIdleComplete, checkDesktopIdle,
  readFile: tailRead,
  scanAll(store) {
    const files = collectFiles(ROOT, isSessionFile, 6);
    let count = 0;
    for (const f of files) {
      // mtime 缓存：文件未变化则跳过，避免每 30s 无谓解压。
      // v3：首次升级时强制重扫一次旧文件，把历史拓扑信号补入 store。
      const mkey = `mtime:v3:${ID}:${f}`;
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
    }
    return count;
  },
};
