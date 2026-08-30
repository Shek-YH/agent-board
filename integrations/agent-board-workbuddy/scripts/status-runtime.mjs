import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_INPUT_BYTES = 1024 * 1024;
export const MAX_SPOOL_BYTES = 512 * 1024;
export const MAX_EVENT_BYTES = 16 * 1024;
export const LOCK_WAIT_MS = 150;
export const LOCK_STALE_MS = 10 * 1000;

export const ALLOWED_EVENTS = Object.freeze([
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied',
  'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted',
  'Elicitation', 'ElicitationResult', 'Notification', 'Stop',
  'StopFailure', 'SessionEnd',
]);
export const BACKGROUND_TASK_EVENTS = Object.freeze([
  'task_started', 'task_progress', 'task_updated', 'task_notification',
]);

const EVENT_SET = new Set([...ALLOWED_EVENTS, ...BACKGROUND_TASK_EVENTS]);
const STRING_LIMITS = Object.freeze({
  event: 64,
  session_id: 256,
  tool_name: 128,
  tool_use_id: 256,
  subagent_id: 256,
  subagent_type: 128,
  task_id: 256,
  task_type: 128,
  permission_mode: 64,
  notification_type: 128,
  transcript_path: 1024,
  cwd: 1024,
  status: 32,
  event_id: 256,
});
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function boundedString(value, maxLength) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : null;
}

export function endsWithQuestion(message) {
  if (typeof message !== 'string') return null;
  const trimmed = message.trimEnd();
  return trimmed.endsWith('?') || trimmed.endsWith('？');
}

export function projectEvent(event, payload, now = Date.now()) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const eventName = boundedString(event, STRING_LIMITS.event) || '?';
  const projected = {
    schema_version: 1,
    event: eventName,
    ts: Number.isFinite(now) ? Math.max(0, Math.trunc(now)) : Date.now(),
    session_id: boundedString(input.session_id ?? input.sessionId, STRING_LIMITS.session_id),
  };
  const fields = {
    tool_name: input.tool_name,
    tool_use_id: input.tool_use_id ?? input.tool_id,
    subagent_id: input.subagent_id ?? input.agent_id,
    subagent_type: input.subagent_type,
    task_id: input.task_id,
    task_type: input.task_type,
    permission_mode: input.permission_mode,
    notification_type: input.notification_type,
    transcript_path: input.transcript_path ?? input.transcriptPath,
    cwd: input.cwd,
  };
  for (const [field, source] of Object.entries(fields)) {
    const value = boundedString(source, STRING_LIMITS[field]);
    if (value) projected[field] = value;
  }
  if (eventName === 'Stop') {
    // heuristic only; not authoritative
    projected.ends_with_question = typeof input.ends_with_question === 'boolean'
      ? input.ends_with_question
      : endsWithQuestion(input.last_assistant_message);
  }
  if (typeof input.stop_hook_active === 'boolean') projected.stop_hook_active = input.stop_hook_active;
  if (typeof input.stopHookActive === 'boolean') projected.stop_hook_active = input.stopHookActive;
  const status = input.status ?? input.patch?.status;
  const normalizedStatus = boundedString(status, STRING_LIMITS.status)?.toLowerCase();
  if (normalizedStatus && ['running', 'completed', 'failed', 'stopped', 'killed', 'cancelled'].includes(normalizedStatus)) {
    projected.status = normalizedStatus === 'killed' || normalizedStatus === 'cancelled' ? 'stopped' : normalizedStatus;
  }
  const eventId = boundedString(input.event_id ?? input.eventId ?? input.uuid, STRING_LIMITS.event_id);
  if (eventId) projected.event_id = eventId;
  return projected;
}

export function readStdinLimited(maxBytes = MAX_INPUT_BYTES) {
  const chunks = [];
  let total = 0;
  const buffer = Buffer.allocUnsafe(16 * 1024);
  try {
    while (total <= maxBytes) {
      const size = Math.min(buffer.length, maxBytes + 1 - total);
      const bytesRead = fs.readSync(0, buffer, 0, size, null);
      if (!bytesRead) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      total += bytesRead;
    }
  } catch {
    return '';
  }
  return total > maxBytes ? '' : Buffer.concat(chunks, total).toString('utf8');
}

export function parseHookInput(raw) {
  try {
    const parsed = JSON.parse(typeof raw === 'string' ? raw : '');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function absoluteOverride(value) {
  return typeof value === 'string' && value.trim() && path.isAbsolute(value) ? path.normalize(value.trim()) : null;
}

export function resolveSpoolPath({ env = process.env, homedir = os.homedir } = {}) {
  const explicit = absoluteOverride(env.AGENT_BOARD_WORKBUDDY_SPOOL_PATH)
    || absoluteOverride(env.WB_BUDDY_SPOOL);
  if (explicit) return explicit;
  const dataDir = absoluteOverride(env.AGENT_BOARD_WORKBUDDY_DATA_DIR)
    || absoluteOverride(env.WB_BUDDY_DATA_DIR)
    || absoluteOverride(env.AGENT_BOARD_DATA_DIR)
    || absoluteOverride(env.AB_DATA_DIR);
  if (dataDir) return path.join(dataDir, 'workbuddy', 'events.spool');
  const home = absoluteOverride(typeof homedir === 'function' ? homedir() : homedir);
  return home ? path.join(home, '.workbuddy-buddy', 'events.spool') : null;
}

function loopbackUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname.toLowerCase())) return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function resolveHttpHookConfigPath({ env = process.env, homedir = os.homedir } = {}) {
  const explicit = absoluteOverride(env.AGENT_BOARD_WORKBUDDY_HTTP_CONFIG_PATH);
  if (explicit) return explicit;
  const dataDir = absoluteOverride(env.AGENT_BOARD_WORKBUDDY_DATA_DIR)
    || absoluteOverride(env.WB_BUDDY_DATA_DIR)
    || absoluteOverride(env.AGENT_BOARD_DATA_DIR)
    || absoluteOverride(env.AB_DATA_DIR);
  if (dataDir) return path.join(dataDir, 'workbuddy', 'http-hook.json');
  const home = absoluteOverride(typeof homedir === 'function' ? homedir() : homedir);
  if (!home) return null;
  const root = process.platform === 'win32'
    ? absoluteOverride(env.LOCALAPPDATA) || path.join(home, 'AppData', 'Local')
    : absoluteOverride(env.XDG_DATA_HOME) || path.join(home, '.local', 'share');
  return path.join(root, 'AgentBoard', 'workbuddy', 'http-hook.json');
}

export function readHttpHookConfig({ env = process.env, homedir = os.homedir, fsApi = fs } = {}) {
  const environmentUrl = loopbackUrl(env.AGENT_BOARD_WORKBUDDY_HTTP_URL);
  const environmentToken = boundedString(env.AGENT_BOARD_WORKBUDDY_HTTP_TOKEN, 256);
  if (environmentUrl && environmentToken && environmentToken.length >= 32) {
    return { url: environmentUrl, token: environmentToken, source: 'environment' };
  }
  const filePath = resolveHttpHookConfigPath({ env, homedir });
  if (!filePath) return null;
  try {
    const value = JSON.parse(fsApi.readFileSync(filePath, 'utf8'));
    const url = loopbackUrl(value?.url);
    const token = boundedString(value?.token, 256);
    if (!url || !token || token.length < 32) return null;
    return { url, token, source: 'file' };
  } catch {
    return null;
  }
}

export async function postProjectedEvent(event, {
  config = readHttpHookConfig(),
  fetchImpl = globalThis.fetch,
  timeoutMs = 250,
} = {}) {
  if (!config || typeof fetchImpl !== 'function' || !event || typeof event !== 'object') return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 250));
  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    return response?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(milliseconds) {
  Atomics.wait(sleepBuffer, 0, 0, milliseconds);
}

function safeLstat(filePath) {
  try { return fs.lstatSync(filePath); } catch (error) { return error?.code === 'ENOENT' ? null : null; }
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = safeLstat(directory);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) throw new Error('spool directory is unsafe');
  if (process.platform !== 'win32') {
    try { fs.chmodSync(directory, 0o700); } catch { /* fail-open */ }
  }
}

function removeStaleLock(lockPath, now = Date.now()) {
  const metadata = safeLstat(lockPath);
  if (metadata?.isFile() && !metadata.isSymbolicLink() && now - metadata.mtimeMs > LOCK_STALE_MS) {
    try { fs.unlinkSync(lockPath); } catch { /* another hook won the race */ }
  }
}

function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() <= deadline) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx');
      const token = `${process.pid}:${randomUUID()}\n`;
      fs.writeSync(descriptor, token);
      return { descriptor, token };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      removeStaleLock(lockPath);
      sleep(5);
    }
  }
  return null;
}

function releaseLock(lockPath, lock) {
  try { fs.closeSync(lock.descriptor); } catch { /* fail-open */ }
  try {
    const metadata = safeLstat(lockPath);
    if (metadata?.isFile() && !metadata.isSymbolicLink() && fs.readFileSync(lockPath, 'utf8') === lock.token) {
      fs.unlinkSync(lockPath);
    }
  } catch { /* fail-open */ }
}

function regularFileOrMissing(filePath) {
  const metadata = safeLstat(filePath);
  if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) throw new Error('spool path is unsafe');
  return metadata;
}

function rotateIfNeeded(spoolPath, additionalBytes, maxBytes) {
  const metadata = regularFileOrMissing(spoolPath);
  if (!metadata || metadata.size + additionalBytes <= maxBytes) return;
  const previousPath = `${spoolPath}.1`;
  const previous = regularFileOrMissing(previousPath);
  if (previous) fs.unlinkSync(previousPath);
  fs.renameSync(spoolPath, previousPath);
}

export function appendProjectedEvent(spoolPath, event, { maxBytes = MAX_SPOOL_BYTES } = {}) {
  if (typeof spoolPath !== 'string' || !path.isAbsolute(spoolPath)) return false;
  if (!event || typeof event !== 'object' || Array.isArray(event) || !EVENT_SET.has(event.event)) return false;
  const serialized = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
  if (serialized.length > MAX_EVENT_BYTES || serialized.length > maxBytes) return false;
  const directory = path.dirname(spoolPath);
  const lockPath = `${spoolPath}.lock`;
  let lock = null;
  let descriptor = null;
  try {
    ensurePrivateDirectory(directory);
    lock = acquireLock(lockPath);
    if (!lock) return false;
    rotateIfNeeded(spoolPath, serialized.length, maxBytes);
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0);
    descriptor = fs.openSync(spoolPath, flags, 0o600);
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile()) return false;
    fs.writeSync(descriptor, serialized);
    if (process.platform !== 'win32') {
      try { fs.fchmodSync(descriptor, 0o600); } catch { /* fail-open */ }
    }
    return true;
  } catch {
    return false;
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* fail-open */ }
    }
    if (lock) releaseLock(lockPath, lock);
  }
}
