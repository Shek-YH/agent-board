'use strict';

const path = require('node:path');
const { extractCodexThreadId, isValidCodexThreadId } = require('../codex-deep-link');

// 回合完成的等待不再是无界死等（原 timeoutMs:0 在通知缺失时会让 DISPATCHING 永久卡死，
// 且 app-server 的 writer 锁一直不放，导致 Codex Desktop 报「已在另一个应用中打开」）。
const DEFAULT_TURN_WAIT_MS = 15 * 60 * 1000;

function provisionError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
}

function responsePayload(response) {
  return response && response.result && typeof response.result === 'object' ? response.result : response;
}

function threadFromResponse(response) {
  const payload = responsePayload(response);
  return payload && payload.thread && typeof payload.thread === 'object' ? payload.thread : payload;
}

function turnFromResponse(response) {
  const payload = responsePayload(response);
  const notificationPayload = response && response.params && typeof response.params === 'object' ? response.params : null;
  const source = notificationPayload || payload;
  return source && source.turn && typeof source.turn === 'object' ? source.turn : null;
}

function threadIdFromSessionRef(sessionRef) {
  const value = String(sessionRef || '').trim();
  const threadId = isValidCodexThreadId(value) ? value : extractCodexThreadId(value);
  if (!threadId) throw provisionError('SESSION_REF_INVALID', 'Codex Session 缺少有效 thread ID');
  return threadId;
}

function createCodexSessionProvisioner({ request, waitForNotification, close, releaseAfterCreate = false } = {}) {
  if (typeof request !== 'function') throw new TypeError('Codex session provisioner request is required');

  async function closeTransport() {
    if (typeof close !== 'function') return;
    try { await close(); } catch { /* 释放锁失败不应覆盖已经完成的 turn 结果 */ }
  }

  async function waitForTurnCompletion(threadId, turnId) {
    if (typeof waitForNotification !== 'function') return null;
    return waitForNotification({
      method: 'turn/completed',
      predicate: (event) => {
        const params = event && event.params || {};
        const pThread = params.threadId ?? params.thread_id ?? (params.turn && (params.turn.threadId ?? params.turn.thread_id)) ?? null;
        const pTurn = params.turn || {};
        const pTurnId = params.turnId ?? pTurn.id ?? pTurn.turnId ?? null;
        const threadOk = !threadId || !pThread || String(pThread) === String(threadId);
        return Boolean(pTurnId && String(pTurnId) === String(turnId) && threadOk);
      },
      // 有界等待：通知缺失时不再死等，超时返回 null 由调用方按「已接受」处理。
      timeoutMs: DEFAULT_TURN_WAIT_MS,
    }).catch(() => null);
  }

  return {
    agent: 'codex',
    supported: true,
    async create({ projectPath, title = '' } = {}) {
      const cwd = path.resolve(String(projectPath || '').trim());
      if (!cwd || cwd === path.resolve('.')) throw provisionError('PROJECT_PATH_REQUIRED', '创建 Session 需要项目文件夹');
      try {
        const response = await request('thread/start', { cwd });
        const thread = threadFromResponse(response);
        const threadId = String(thread && (thread.id || thread.threadId) || '').trim();
        if (!isValidCodexThreadId(threadId)) throw provisionError('SESSION_CREATION_UNVERIFIED', 'Codex 未返回可验证的真实 thread ID');
        const name = String(title || '').trim().slice(0, 300);
        if (name) await request('thread/name/set', { threadId, name });
        return { sessionRef: `codex:${threadId}`, agent: 'codex', projectPath: cwd, transport: 'codex-app-server' };
      } finally {
        if (releaseAfterCreate) await closeTransport();
      }
    },
    async startTurn({ sessionRef, message } = {}) {
      const threadId = threadIdFromSessionRef(sessionRef);
      const text = String(message == null ? '' : message);
      if (!text.trim()) throw provisionError('EMPTY_MESSAGE', 'Codex 首轮指令不能为空');
      let shouldRelease = releaseAfterCreate;
      try {
        if (releaseAfterCreate) {
          await request('thread/resume', { threadId });
        }
        const response = await request('turn/start', {
          threadId,
          input: [{ type: 'text', text }],
        });
        const turn = turnFromResponse(response);
        const turnId = String(turn && (turn.id || turn.turnId) || '').trim();
        const status = String(turn && turn.status || '').trim();
        if (!turnId || !['completed', 'inProgress', 'interrupted', 'failed'].includes(status)) {
          shouldRelease = true;
          throw provisionError('TURN_CREATION_UNVERIFIED', 'Codex 未返回可验证的真实 turn');
        }
        // 接受即返回：不再等待 turn/completed 通知（Codex app-server 在此环境不发该通知，
        // 会让 nativeDispatch 一直卡在 DISPATCHING）。回合完成的识别交由「会话文件 →
        // 回复检测 → reconcile」驱动。inProgress 时保留 app-server 存活让回合继续执行。
        const accepted = ['completed', 'inProgress'].includes(status);
        shouldRelease = status !== 'inProgress';
        return {
          ok: accepted,
          threadId,
          turnId,
          status,
          ...(!accepted ? { code: status === 'failed' ? 'TURN_FAILED' : 'TURN_NOT_ACCEPTED', reason: turn.error?.message || 'Codex turn 未被接受' } : {}),
        };
      } finally {
        if (shouldRelease) await closeTransport();
      }
    },
  };
}

async function provisionSession({ agent, projectPath, title = '', provisioners = {} } = {}) {
  const id = String(agent || '').trim().toLowerCase();
  const provisioner = provisioners instanceof Map ? provisioners.get(id) : provisioners[id];
  if (!provisioner || provisioner.supported !== true || typeof provisioner.create !== 'function') {
    throw provisionError('SESSION_CREATION_UNAVAILABLE', `当前 Agent（${id || '未知'}）没有可靠的真实 Session 创建能力`);
  }
  const session = await provisioner.create({ projectPath, title });
  if (!session || session.agent !== id || !String(session.sessionRef || '').trim()) {
    throw provisionError('SESSION_CREATION_UNVERIFIED', 'Agent 未返回可验证的真实 Session');
  }
  return session;
}

module.exports = { createCodexSessionProvisioner, provisionSession };
