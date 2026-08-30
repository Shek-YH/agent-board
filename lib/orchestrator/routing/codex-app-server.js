'use strict';

const { extractCodexThreadId, isValidCodexThreadId } = require('../../codex-deep-link');
const { normalizeCatalogResponse } = require('./catalog');

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
  return { modelId, reasoningLevel, threadId: expectedThreadId, source: 'native' };
}

function createCodexAppServerCapability({ request, waitForNotification, agentVersion = null } = {}) {
  if (typeof request !== 'function') throw new TypeError('Codex app-server request function is required');

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
      const threadId = resolveThreadId(sessionRef);
      const modelId = text(profile && profile.modelId);
      const reasoningLevel = text(profile && profile.reasoningLevel).toLowerCase();
      if (!modelId || !reasoningLevel) {
        const error = new Error('Codex execution profile is incomplete');
        error.code = 'INVALID_PROFILE';
        throw error;
      }
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
    },
  };
}

module.exports = { SETTINGS_UPDATED_METHOD, createCodexAppServerCapability, resolveThreadId };
