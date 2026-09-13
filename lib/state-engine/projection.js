'use strict';

const { ACTIVITY_STATES, ATTENTION_STATES, SESSION_LIFECYCLE_STATES, TURN_STATES } = require('./enums');

const MODES = new Set(['off', 'shadow', 'on']);

function resolveStateEngineMode(value = process.env.STATE_ENGINE_V2) {
  const mode = String(value || 'off').trim().toLowerCase();
  return MODES.has(mode) ? mode : 'off';
}

function canonicalSnapshot(runtime) {
  return {
    liveness: runtime.liveness,
    sessionLifecycle: runtime.sessionLifecycle,
    turnState: runtime.turnState,
    activityState: runtime.activityState,
    attentionState: runtime.attentionState,
  };
}

function status(key, label, kind, runtime) {
  return {
    key,
    label,
    kind,
    attentionRequired: runtime.attentionState === ATTENTION_STATES.ACTION_REQUIRED,
    canonical: canonicalSnapshot(runtime),
    confidence: { ...runtime.confidence },
  };
}

function projectUiStatus(runtime) {
  if (!runtime || typeof runtime !== 'object') throw new TypeError('runtime is required');
  switch (runtime.activityState) {
    case ACTIVITY_STATES.WAITING_APPROVAL:
      return status('waiting_approval', '等待批准', 'waiting', runtime);
    case ACTIVITY_STATES.WAITING_USER:
      return status('waiting_user', '等待输入', 'waiting', runtime);
    case ACTIVITY_STATES.WAITING_EXTERNAL:
      return status('waiting_external', '等待外部', 'waiting', runtime);
    case ACTIVITY_STATES.RUNNING_COMMAND:
      return status('running_command', '正在执行命令', 'active', runtime);
    case ACTIVITY_STATES.USING_TOOL:
      return status('using_tool', '正在使用工具', 'active', runtime);
    case ACTIVITY_STATES.RUNNING_SUBAGENT:
      return status('running_subagent', '子代理工作中', 'active', runtime);
    case ACTIVITY_STATES.PLANNING:
      return status('planning', '正在规划', 'active', runtime);
    case ACTIVITY_STATES.THINKING:
      return status('thinking', '正在思考', 'active', runtime);
    case ACTIVITY_STATES.COMPACTING_CONTEXT:
      return status('compacting_context', '正在整理上下文', 'active', runtime);
    case ACTIVITY_STATES.RATE_LIMITED:
      return status('rate_limited', '已限流', 'warning', runtime);
    default:
      break;
  }
  if (runtime.turnState === TURN_STATES.FAILED) return status('failed', '任务失败', 'error', runtime);
  if (runtime.turnState === TURN_STATES.INTERRUPTED) return status('interrupted', '已中断', 'warning', runtime);
  if (runtime.turnState === TURN_STATES.COMPLETED) return status('completed', '本轮已完成', 'success', runtime);
  if (runtime.turnState === TURN_STATES.COMPLETION_CANDIDATE) return status('completion_candidate', '正在确认完成', 'active', runtime);
  if (runtime.sessionLifecycle === SESSION_LIFECYCLE_STATES.CLOSED) return status('session_closed', '会话已关闭', 'neutral', runtime);
  return status('unknown', '状态未知', 'neutral', runtime);
}

function projectLegacyState(runtime) {
  if (!runtime || typeof runtime !== 'object') throw new TypeError('runtime is required');
  if (runtime.turnState === TURN_STATES.FAILED) return 'failed';
  if (runtime.turnState === TURN_STATES.INTERRUPTED) return 'interrupted';
  if (runtime.turnState === TURN_STATES.COMPLETED) return 'completed';
  if ([ACTIVITY_STATES.WAITING_APPROVAL, ACTIVITY_STATES.WAITING_USER, ACTIVITY_STATES.WAITING_EXTERNAL].includes(runtime.activityState)) return 'waiting_user';
  if ([TURN_STATES.STARTING, TURN_STATES.RUNNING, TURN_STATES.COMPLETION_CANDIDATE].includes(runtime.turnState)) return 'running';
  return 'unknown';
}

function hasLegacyDivergence(runtime, legacy, v2) {
  return legacy !== v2.legacyState || (legacy === 'completed' && runtime.sessionLifecycle !== SESSION_LIFECYCLE_STATES.CLOSED);
}

function projectStatus(runtime, mode = resolveStateEngineMode()) {
  const resolvedMode = resolveStateEngineMode(mode);
  const v2 = projectUiStatus(runtime);
  const legacy = projectLegacyState(runtime);
  const v2Summary = { ...v2, legacyState: legacy };
  const divergence = hasLegacyDivergence(runtime, legacy, v2Summary);
  if (resolvedMode === 'on') {
    return { mode: resolvedMode, source: 'state-engine-v2', state: v2Summary, legacyState: legacy, v2: v2Summary, divergence };
  }
  return {
    mode: resolvedMode,
    source: 'legacy',
    state: legacy,
    legacyState: legacy,
    v2: v2Summary,
    ...(resolvedMode === 'shadow' ? { shadow: v2Summary, divergence } : { divergence: false }),
  };
}

module.exports = { resolveStateEngineMode, projectUiStatus, projectLegacyState, projectStatus };
