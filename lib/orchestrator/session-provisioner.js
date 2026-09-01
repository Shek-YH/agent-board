'use strict';

const path = require('node:path');
const { extractCodexThreadId, isValidCodexThreadId } = require('../codex-deep-link');

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
        const params = event && event.params;
        return Boolean(params && params.threadId === threadId && params.turn && params.turn.id === turnId);
      },
      // 托管任务可能运行很久；由 app-server 进程退出负责打破等待，不使用默认的短请求超时。
      timeoutMs: 0,
    });
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
        let turnId = String(turn && (turn.id || turn.turnId) || '').trim();
        let status = String(turn && turn.status || '').trim();
        if (!turnId || !['completed', 'inProgress', 'interrupted', 'failed'].includes(status)) {
          shouldRelease = true;
          throw provisionError('TURN_CREATION_UNVERIFIED', 'Codex 未返回可验证的真实 turn');
        }

        if (status === 'inProgress' && typeof waitForNotification === 'function') {
          let completion;
          try {
            completion = await waitForTurnCompletion(threadId, turnId);
          } catch (error) {
            shouldRelease = true;
            throw error;
          }
          const completedTurn = turnFromResponse(completion);
          const completedId = String(completedTurn && (completedTurn.id || completedTurn.turnId) || '').trim();
          const completedStatus = String(completedTurn && completedTurn.status || '').trim();
          if (!completedTurn || completedId !== turnId || !['completed', 'interrupted', 'failed'].includes(completedStatus)) {
            shouldRelease = true;
            throw provisionError('TURN_COMPLETION_UNVERIFIED', 'Codex 未返回可验证的 turn 完成状态');
          }
          turnId = completedId;
          status = completedStatus;
        }

        if (status === 'inProgress' && typeof waitForNotification !== 'function') shouldRelease = false;
        shouldRelease = ['completed', 'interrupted', 'failed'].includes(status);
        const accepted = ['completed', 'inProgress'].includes(status);
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
