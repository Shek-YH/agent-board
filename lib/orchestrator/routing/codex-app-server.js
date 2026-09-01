'use strict';

const { extractCodexThreadId, isValidCodexThreadId } = require('../../codex-deep-link');
const { normalizeCatalogResponse } = require('./catalog');
const { DEFAULT_CODEX_CACHE_PATH, loadCodexCatalogCache } = require('./catalog-store');

const SETTINGS_UPDATED_METHOD = 'thread/settings/updated';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveThreadId(sessionRef) {
  const value = text(sessionRef);
  const threadId = isValidCodexThreadId(value) ? value : extractCodexThreadId(value);
  if (!threadId) {
    const error = new Error('Codex sessionRef does not contain a valid thread id');
    error.code = 'INVALID_SESSION_REF';
    throw error;
  }
  return threadId;
}

function settingsFromNotification(notification, expectedThreadId) {
  const payload = notification && typeof notification === 'object'
    ? (notification.params && typeof notification.params === 'object' ? notification.params : notification)
    : {};
  const threadId = text(payload.threadId);
  if (threadId !== expectedThreadId) {
    const error = new Error('Codex settings readback belongs to a different session');
    error.code = 'SESSION_DRIFT';
    error.expectedThreadId = expectedThreadId;
    error.actualThreadId = threadId || null;
    throw error;
  }
  const settings = payload.threadSettings && typeof payload.threadSettings === 'object'
    ? payload.threadSettings
    : {};
  const modelId = text(settings.model || settings.modelId);
  const reasoningLevel = text(settings.effort || settings.reasoningEffort || settings.reasoningLevel).toLowerCase();
  if (!modelId || !reasoningLevel) {
    const error = new Error('Codex settings readback is incomplete');
    error.code = 'PROFILE_READBACK_INCOMPLETE';
    throw error;
  }
  const changedBy = text(payload.changedBy || payload.changed_by || payload.actor || settings.changedBy || settings.changed_by || settings.actor).toLowerCase();
  const source = text(payload.source || settings.source).toLowerCase();
  const manualPin = payload.manualPin === true || payload.manual_pin === true
    || ['human', 'user', 'manual'].includes(changedBy) || ['human', 'user', 'manual'].includes(source);
  return {
    modelId, reasoningLevel, threadId: expectedThreadId, source: 'native',
    ...(manualPin ? { manualPin: true, changedBy: 'human' } : {}),
  };
}

function createCodexAppServerCapability({ request, waitForNotification, close, agentVersion = null } = {}) {
  if (typeof request !== 'function') throw new TypeError('Codex app-server request function is required');

  async function closeTransport() {
    if (typeof close === 'function') await close();
  }

  async function readProfile({ sessionRef, notification } = {}) {
    const threadId = resolveThreadId(sessionRef);
    const event = notification || (typeof waitForNotification === 'function'
      ? await waitForNotification({
        method: SETTINGS_UPDATED_METHOD,
        predicate: (candidate) => {
          const params = candidate && candidate.params;
          return Boolean(params && params.threadId === threadId);
        },
      })
      : null);
    if (!event) {
      const error = new Error('Codex settings readback capability is unavailable');
      error.code = 'PROFILE_READBACK_UNAVAILABLE';
      throw error;
    }
    return settingsFromNotification(event, threadId);
  }

  return {
    name: 'codex-app-server',
    catalogCacheReader: () => loadCodexCatalogCache(DEFAULT_CODEX_CACHE_PATH),
    async listModels() {
      const response = await request('model/list', { includeHidden: false });
      return normalizeCatalogResponse(response && response.result ? response.result : response, {
        source: 'native',
        agentVersion: typeof agentVersion === 'function' ? await agentVersion() : agentVersion,
      });
    },
    async readProfile({ sessionRef, notification } = {}) {
      return readProfile({ sessionRef, notification });
    },
    async applyProfile({ sessionRef, profile } = {}) {
      try {
        const threadId = resolveThreadId(sessionRef);
        const modelId = text(profile && profile.modelId);
        const reasoningLevel = text(profile && profile.reasoningLevel).toLowerCase();
        if (!modelId || !reasoningLevel) {
          const error = new Error('Codex execution profile is incomplete');
          error.code = 'INVALID_PROFILE';
          throw error;
        }
        // Session 创建与路由能力可能使用不同的 app-server 进程；
        // settings/update 只对当前进程已加载的 thread 生效，先按真实 ID 恢复持久化线程。
        await request('thread/resume', { threadId });
        await request('thread/settings/update', {
          threadId,
          model: modelId,
          effort: reasoningLevel,
        });
        const readback = await readProfile({ sessionRef: threadId });
        return {
          modelId,
          reasoningLevel,
          threadId,
          source: 'native',
          readback,
          verified: readback.modelId === modelId && readback.reasoningLevel === reasoningLevel,
          evidence: {
            applyMethod: 'thread/settings/update',
            readbackMethod: SETTINGS_UPDATED_METHOD,
          },
        };
      } finally {
        // thread/resume creates a process-scoped writer lease. Release it before
        // a separate session app-server or Codex Desktop touches the same thread.
        await closeTransport();
      }
    },
  };
}

module.exports = { SETTINGS_UPDATED_METHOD, createCodexAppServerCapability, resolveThreadId };
