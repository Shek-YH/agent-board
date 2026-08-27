'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DESKTOP_SESSION_ID_PATTERN = /^local_[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

function defaultClaudeDesktopSessionsRoots(env = process.env, home = os.homedir()) {
  if (process.platform === 'darwin') {
    return [
      path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions'),
      path.join(home, 'Library', 'Application Support', 'Claude', 'local', 'claude-code-sessions'),
    ];
  }
  const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const roots = [path.join(roaming, 'Claude', 'claude-code-sessions')];
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const packageRoot = path.join(local, 'Packages');
  try {
    for (const entry of fs.readdirSync(packageRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && /^Claude(?:_|$)/i.test(entry.name)) {
        roots.push(path.join(packageRoot, entry.name, 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions'));
      }
    }
  } catch { /* packaged/non-MSIX installations may not have a Packages directory */ }
  roots.push(path.join(local, 'Claude-3p', 'claude-code-sessions'));
  return [...new Set(roots)];
}

function defaultClaudeDesktopSessionsRoot(env = process.env, home = os.homedir()) {
  return defaultClaudeDesktopSessionsRoots(env, home)[0];
}

function isValidCliSessionId(value) {
  return typeof value === 'string' && CLI_SESSION_ID_PATTERN.test(value);
}

function isValidDesktopSessionId(value) {
  return typeof value === 'string' && DESKTOP_SESSION_ID_PATTERN.test(value);
}

function readOptionalString(value) {
  return typeof value === 'string' && value ? value : undefined;
}

function parseClaudeDesktopSession(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const sessionId = raw.sessionId;
  const cliSessionId = raw.cliSessionId;
  if (!isValidDesktopSessionId(sessionId) || !isValidCliSessionId(cliSessionId)) return null;
  const descriptor = { sessionId, cliSessionId };
  const cwd = readOptionalString(raw.cwd);
  const title = readOptionalString(raw.title);
  if (cwd !== undefined) descriptor.cwd = cwd;
  if (title !== undefined) descriptor.title = title;
  if (typeof raw.lastActivityAt === 'number' || typeof raw.lastActivityAt === 'string') {
    descriptor.lastActivityAt = raw.lastActivityAt;
  }
  if (typeof raw.archived === 'boolean') descriptor.archived = raw.archived;
  return descriptor;
}

function collectDescriptorFiles(root) {
  const out = [];
  if (!root || !fs.existsSync(root)) return out;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectDescriptorFiles(file));
    } else if (entry.isFile() && /^local_.+\.json$/i.test(entry.name)) {
      out.push(file);
    }
  }
  return out;
}

function listClaudeDesktopSessions(root) {
  const roots = root === undefined
    ? defaultClaudeDesktopSessionsRoots()
    : (Array.isArray(root) ? root : [root]);
  const out = [];
  const seen = new Set();
  for (const currentRoot of roots) {
    for (const file of collectDescriptorFiles(currentRoot)) {
      if (seen.has(file)) continue;
      seen.add(file);
      try {
        const descriptor = parseClaudeDesktopSession(JSON.parse(fs.readFileSync(file, 'utf8')));
        if (descriptor) out.push(descriptor);
      } catch { /* descriptor may be mid-write or stale; ignore it */ }
    }
  }
  return out;
}

function buildClaudeResumeDeepLink(cliSessionId, cwd) {
  if (!isValidCliSessionId(cliSessionId)) throw new TypeError('无效的 Claude cliSessionId');
  // Claude Desktop 当前 Windows 构建的 resume handler 只稳定读取 session；
  // 附加 cwd 会让部分版本把整个 query 当成无效恢复请求。项目路径仍由
  // 看板记录保留，并在 CLI fallback 时作为终端工作目录使用。
  return `claude://resume?session=${encodeURIComponent(cliSessionId)}`;
}

function buildClaudeFocusDeepLink(desktopSessionId) {
  if (!isValidDesktopSessionId(desktopSessionId)) throw new TypeError('无效的 Claude desktopSessionId');
  return `claude://claude.ai/code/${encodeURIComponent(desktopSessionId)}`;
}

function chooseDescriptor(candidates, cliSessionId, cwd) {
  const imported = candidates.filter((item) => item.sessionId === `local_${cliSessionId}`);
  if (imported.length === 1) return imported[0];
  if (imported.length > 1) return { ambiguous: imported };

  if (typeof cwd === 'string' && cwd) {
    const cwdMatches = candidates.filter((item) => item.cwd === cwd);
    if (cwdMatches.length === 1) return cwdMatches[0];
    if (cwdMatches.length > 1) return { ambiguous: cwdMatches };
  }
  if (candidates.length === 1) return candidates[0];
  return { ambiguous: candidates };
}

function resolveClaudeSessionTarget({ cliSessionId, cwd, root }) {
  if (!isValidCliSessionId(cliSessionId)) throw new TypeError('无效的 Claude cliSessionId');
  const candidates = listClaudeDesktopSessions(root).filter((item) => item.cliSessionId === cliSessionId);
  if (!candidates.length) {
    return {
      status: 'resolved',
      origin: 'cli',
      action: 'resume',
      cliSessionId,
      deepLink: buildClaudeResumeDeepLink(cliSessionId, cwd),
    };
  }

  const chosen = chooseDescriptor(candidates, cliSessionId, cwd);
  if (chosen.ambiguous) {
    return { status: 'ambiguous', cliSessionId, candidates: chosen.ambiguous };
  }

  const imported = chosen.sessionId === `local_${cliSessionId}`;
  return {
    status: 'resolved',
    origin: imported ? 'imported-cli' : 'desktop',
    action: imported ? 'resume' : 'focus',
    cliSessionId,
    desktopSessionId: chosen.sessionId,
    cwd: chosen.cwd,
    title: chosen.title,
    deepLink: imported
      ? buildClaudeResumeDeepLink(cliSessionId, cwd || chosen.cwd)
      : buildClaudeFocusDeepLink(chosen.sessionId),
  };
}

module.exports = {
  defaultClaudeDesktopSessionsRoots,
  defaultClaudeDesktopSessionsRoot,
  isValidCliSessionId,
  isValidDesktopSessionId,
  parseClaudeDesktopSession,
  listClaudeDesktopSessions,
  buildClaudeResumeDeepLink,
  buildClaudeFocusDeepLink,
  resolveClaudeSessionTarget,
};
