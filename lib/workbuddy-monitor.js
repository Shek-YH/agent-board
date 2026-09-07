'use strict';

const WORKBUDDY_EVENTS = Object.freeze([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
]);

const BACKGROUND_TASK_EVENTS = Object.freeze([
  'task_started',
  'task_progress',
  'task_updated',
  'task_notification',
]);

const EVENT_SET = new Set([...WORKBUDDY_EVENTS, ...BACKGROUND_TASK_EVENTS]);
const WORKBUDDY_INTERNAL_STATES = Object.freeze([
  'idle', 'planning', 'running', 'running_tool', 'running_subagent',
  'waiting_user', 'candidate_completion', 'completed', 'failed', 'unknown',
]);
const COMPLETION_STABILIZATION_MS = 5000;
const PENDING_COMPLETION_MAX_MS = 10 * 60 * 1000;
const MAX_SEEN_EVENTS = 4096;
const RUNNING_STATUSES = new Set(['thinking', 'running', 'running_tool', 'running_subagent']);
const DEFAULT_STALE_THRESHOLDS = Object.freeze({
  thinking: 5 * 60 * 1000,
  running: 5 * 60 * 1000,
  running_tool: 10 * 60 * 1000,
  running_subagent: 20 * 60 * 1000,
});
const DEFAULT_CAPABILITIES = Object.freeze({
  hooks: true,
  stopHookActive: true,
  httpHook: false,
  transcriptPath: true,
  backgroundTaskEvents: false,
});
const WAITING_NOTIFICATION_TYPES = new Set([
  'permission_prompt',
  'idle_prompt',
  'elicitation_dialog',
]);
const TERMINAL_BACKGROUND_STATUSES = new Set(['completed', 'failed', 'stopped']);

function boundedString(value, maxLength) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : null;
}

function eventTimestamp(value, now) {
  const ts = Number(value);
  return Number.isFinite(ts) && ts > 0 ? Math.trunc(ts) : Math.trunc(now());
}

function normalizeBackgroundStatus(value) {
  const status = boundedString(value, 32)?.toLowerCase();
  if (status === 'killed' || status === 'cancelled') return 'stopped';
  return TERMINAL_BACKGROUND_STATUSES.has(status) || status === 'running' ? status : null;
}

function eventId(event) {
  if (event.event_id) return event.event_id;
  return [
    event.event,
    event.ts,
    event.session_id,
    event.tool_use_id,
    event.subagent_id,
    event.task_id,
    event.task_status,
    event.stop_hook_active === true ? 'stop-hook-active' : '',
  ].map((value) => value || '').join(':');
}

function normalizeEvent(input, now = Date.now) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const name = boundedString(source.event ?? source.hook_event_name ?? source.subtype, 64);
  if (!EVENT_SET.has(name)) return { diagnostic: 'unknown-event', event: name || null };
  const sessionId = boundedString(source.session_id ?? source.sessionId, 256);
  if (!sessionId) return { diagnostic: 'missing-session-id', event: name };
  const taskPatch = source.patch && typeof source.patch === 'object' ? source.patch : null;
  const normalized = {
    schema_version: Number(source.schema_version) || 1,
    event: name,
    ts: eventTimestamp(source.ts ?? source.timestamp, now),
    session_id: sessionId,
    tool_name: boundedString(source.tool_name, 128),
    tool_use_id: boundedString(source.tool_use_id ?? source.tool_id, 256),
    subagent_id: boundedString(source.subagent_id ?? source.agent_id, 256),
    subagent_type: boundedString(source.subagent_type, 128),
    task_id: boundedString(source.task_id, 256),
    task_type: boundedString(source.task_type, 128),
    task_description: boundedString(source.description, 256),
    task_status: normalizeBackgroundStatus(source.status ?? taskPatch?.status ?? source.task_status),
    notification_type: boundedString(source.notification_type ?? source.notificationType, 128),
    permission_mode: boundedString(source.permission_mode, 64),
    reason: boundedString(source.reason, 64),
    transcript_path: boundedString(source.transcript_path ?? source.transcriptPath, 1024),
    cwd: boundedString(source.cwd, 1024),
    ends_with_question: typeof source.ends_with_question === 'boolean' ? source.ends_with_question : null,
    stop_hook_active: typeof source.stop_hook_active === 'boolean'
      ? source.stop_hook_active
      : typeof source.stopHookActive === 'boolean' ? source.stopHookActive : null,
    event_id: boundedString(source.event_id ?? source.eventId ?? source.uuid, 256),
  };
  normalized.event_id = eventId(normalized);
  return normalized;
}

function mapNotificationType(type) {
  const normalized = boundedString(type, 128)?.toLowerCase();
  return WAITING_NOTIFICATION_TYPES.has(normalized) ? 'waiting_user' : null;
}

function publicState(status) {
  if (['planning', 'thinking', 'running', 'running_tool', 'running_subagent', 'candidate_completion'].includes(status)) return 'running';
  if (status === 'waiting_user') return 'waiting_user_input';
  return status;
}

function createRuntime(sessionId, capabilities) {
  return {
    sessionId,
    status: 'idle',
    internalState: 'idle',
    turnId: null,
    turnSequence: 0,
    turnIsCurrent: false,
    activeToolIds: new Set(),
    activeSubagentIds: new Set(),
    activeBackgroundTasks: new Map(),
    toolSequence: 0,
    subagentSequence: 0,
    waitingForPermission: false,
    waitingForElicitation: false,
    waitingFromNotification: false,
    lastQuestionSignal: null,
    lastStopHookActive: null,
    lastEventAt: 0,
    lastEventType: null,
    transcriptPath: null,
    cwd: null,
    lastStopAt: null,
    candidateStopTs: null,
    pendingCompletion: false,
    pendingSince: 0,
    completionTimer: null,
    lastCompletionEventId: null,
    lastCompletionId: null,
    lastCompletedTurnId: null,
    lastNotifiedCompletionId: null,
    lastFailureNotificationId: null,
    baselinePending: false,
    baselineEstablished: false,
    capabilities,
  };
}

function snapshot(runtime) {
  return {
    provider: 'workbuddy',
    sessionId: runtime.sessionId,
    status: runtime.status,
    state: publicState(runtime.status),
    internalState: runtime.internalState,
    turnId: runtime.turnId,
    turnIsCurrent: runtime.turnIsCurrent,
    activeToolCount: runtime.activeToolIds.size,
    activeToolIds: [...runtime.activeToolIds],
    activeSubagentCount: runtime.activeSubagentIds.size,
    activeSubagentIds: [...runtime.activeSubagentIds],
    activeBackgroundTaskCount: runtime.activeBackgroundTasks.size,
    activeBackgroundTasks: [...runtime.activeBackgroundTasks.values()].map((task) => ({ ...task })),
    waitingForPermission: runtime.waitingForPermission,
    waitingForElicitation: runtime.waitingForElicitation,
    waitingFromNotification: runtime.waitingFromNotification,
    lastQuestionSignal: runtime.lastQuestionSignal,
    lastStopHookActive: runtime.lastStopHookActive,
    lastEventAt: runtime.lastEventAt,
    lastEventType: runtime.lastEventType,
    lastStopAt: runtime.lastStopAt,
    candidateStopTs: runtime.candidateStopTs,
    pendingCompletion: runtime.pendingCompletion,
    lastCompletionEventId: runtime.lastCompletionEventId,
    lastCompletionId: runtime.lastCompletionId,
    lastNotifiedCompletionId: runtime.lastNotifiedCompletionId,
    lastFailureNotificationId: runtime.lastFailureNotificationId,
    baselineEstablished: runtime.baselineEstablished,
    capabilities: { ...runtime.capabilities },
    source: 'workbuddy_hooks',
  };
}

function makeCompletionId(runtime) {
  return `${runtime.sessionId}:${runtime.turnId}:${runtime.candidateStopTs ?? runtime.lastStopAt}`;
}

function createWorkBuddyMonitor(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const stabilizationMs = Math.max(0, Number(options.stabilizationMs ?? COMPLETION_STABILIZATION_MS));
  const pendingMaxMs = Math.max(stabilizationMs, Number(options.pendingMaxMs ?? PENDING_COMPLETION_MAX_MS));
  const staleThresholds = { ...DEFAULT_STALE_THRESHOLDS, ...(options.staleThresholds || {}) };
  const capabilities = { ...DEFAULT_CAPABILITIES, ...(options.capabilities || {}) };
  // 活体否决：confirmCompletion 前若返回 true，说明 stop 之后仍有真实活动（新消息 / SQLite 变 active /
  // 心跳新鲜 / 进程存活），应取消完成候选而非发声。由 host（store）注入，默认 null 不否决。
  const isLiveStill = typeof options.isLiveStill === 'function' ? options.isLiveStill : null;
  const sessions = new Map();
  const seenEvents = new Set();
  const seenEventOrder = [];
  const notifications = [];
  const failures = [];
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
  const onCompletion = typeof options.onCompletion === 'function' ? options.onCompletion : () => {};
  const onFailure = typeof options.onFailure === 'function' ? options.onFailure : () => {};
  const onDiagnostic = typeof options.onDiagnostic === 'function' ? options.onDiagnostic : () => {};
  const loadLastNotifiedCompletionId = typeof options.loadLastNotifiedCompletionId === 'function'
    ? options.loadLastNotifiedCompletionId
    : () => '';
  const saveLastNotifiedCompletionId = typeof options.saveLastNotifiedCompletionId === 'function'
    ? options.saveLastNotifiedCompletionId
    : () => {};

  function getOrCreate(sessionId) {
    let runtime = sessions.get(sessionId);
    if (!runtime) {
      runtime = createRuntime(sessionId, capabilities);
      runtime.lastNotifiedCompletionId = loadLastNotifiedCompletionId(sessionId) || null;
      sessions.set(sessionId, runtime);
    }
    return runtime;
  }

  function emit(runtime) {
    onStatus(snapshot(runtime));
  }

  function clearTimer(runtime) {
    if (runtime.completionTimer) clearTimeout(runtime.completionTimer);
    runtime.completionTimer = null;
  }

  function setStatus(runtime, status) {
    runtime.status = status;
    runtime.internalState = status === 'thinking' ? 'running' : status;
  }

  function nextId(runtime, id, type, ts) {
    if (id) return id;
    const sequenceKey = type === 'tool' ? 'toolSequence' : 'subagentSequence';
    runtime[sequenceKey] += 1;
    return `${type}:${ts}:${runtime[sequenceKey]}`;
  }

  function removeOne(set, id) {
    if (id) {
      set.delete(id);
      return;
    }
    const first = set.values().next();
    if (!first.done) set.delete(first.value);
  }

  function statusAfterActivity(runtime) {
    if (runtime.waitingForPermission || runtime.waitingForElicitation || runtime.waitingFromNotification) return 'waiting_user';
    if (runtime.activeSubagentIds.size) return 'running_subagent';
    if (runtime.activeToolIds.size) return 'running_tool';
    if (runtime.capabilities.backgroundTaskEvents && runtime.activeBackgroundTasks.size) return 'running';
    return runtime.turnId ? 'thinking' : 'idle';
  }

  function cancelCandidate(runtime) {
    const wasPending = runtime.pendingCompletion;
    runtime.pendingCompletion = false;
    runtime.pendingSince = 0;
    runtime.candidateStopTs = null;
    clearTimer(runtime);
    return wasPending;
  }

  function clearNotificationWait(runtime) {
    runtime.waitingFromNotification = false;
  }

  function establishTurnFromActivity(runtime, normalized, baseline) {
    if (baseline || runtime.turnId) return;
    runtime.turnSequence += 1;
    runtime.turnId = `${runtime.sessionId}:${normalized.ts}:${runtime.turnSequence}`;
    runtime.turnIsCurrent = true;
    runtime.lastCompletedTurnId = null;
  }

  function scheduleCompletion(runtime) {
    clearTimer(runtime);
    runtime.completionTimer = setTimeout(() => confirmCompletion(runtime.sessionId), stabilizationMs);
  }

  function notifyCompletion(runtime, completionId, suppressed) {
    runtime.lastCompletionEventId = completionId;
    runtime.lastCompletionId = completionId;
    const event = { completionId, ...snapshot(runtime), completedAt: runtime.lastStopAt };
    const alreadyNotified = runtime.lastNotifiedCompletionId === completionId;
    if (alreadyNotified || suppressed) {
      if (!alreadyNotified) {
        runtime.lastNotifiedCompletionId = completionId;
        saveLastNotifiedCompletionId(runtime.sessionId, completionId);
      }
      return event;
    }
    runtime.lastNotifiedCompletionId = completionId;
    saveLastNotifiedCompletionId(runtime.sessionId, completionId);
    notifications.push(event);
    onCompletion(event);
    return event;
  }

  function confirmCompletion(sessionId, { force = false } = {}) {
    const runtime = sessions.get(sessionId);
    if (!runtime || !runtime.pendingCompletion) return null;
    const elapsed = Math.max(0, Number(clock()) - runtime.pendingSince);
    if (!force && elapsed < stabilizationMs) {
      scheduleCompletion(runtime);
      return null;
    }
    if (runtime.lastStopHookActive === true) {
      cancelCandidate(runtime);
      setStatus(runtime, statusAfterActivity(runtime));
      emit(runtime);
      return null;
    }
    if (runtime.waitingForPermission || runtime.waitingForElicitation || runtime.waitingFromNotification) {
      cancelCandidate(runtime);
      setStatus(runtime, 'waiting_user');
      emit(runtime);
      return null;
    }
    if (
      runtime.activeToolIds.size
      || runtime.activeSubagentIds.size
      || (runtime.capabilities.backgroundTaskEvents && runtime.activeBackgroundTasks.size)
    ) {
      if (elapsed >= pendingMaxMs) {
        cancelCandidate(runtime);
        setStatus(runtime, 'unknown');
        onDiagnostic({ diagnostic: 'pending-completion-stale', sessionId });
        emit(runtime);
        return null;
      }
      scheduleCompletion(runtime);
      return null;
    }
    if (!runtime.turnIsCurrent && !runtime.baselinePending) {
      cancelCandidate(runtime);
      setStatus(runtime, 'idle');
      onDiagnostic({ diagnostic: 'completion-without-current-turn', sessionId });
      emit(runtime);
      return null;
    }
    // L1 活体否决：stop 之后若仍有真实活动（新消息 / SQLite 变 active / 心跳新鲜 / 进程存活），
    // 说明并非真正完成，撤销候选并回到 running，且不发声（L2 反向撤销会在证据到达时即时处理）。
    // 由 host（store）注入 isLiveStill；它比对的是「晚于 stop 时刻」的外部活动证据，
    // 专门兜住 monitor 自身 hook 事件流之外、但会令会话仍在跑的信号（JSONL 新消息 / SQLite / 心跳）。
    if (isLiveStill && runtime.candidateStopTs && isLiveStill(runtime.sessionId, runtime.candidateStopTs)) {
      cancelCandidate(runtime);
      setStatus(runtime, statusAfterActivity(runtime));
      emit(runtime);
      return null;
    }
    const completionId = makeCompletionId(runtime);
    runtime.pendingCompletion = false;
    runtime.pendingSince = 0;
    runtime.candidateStopTs = null;
    clearTimer(runtime);
    setStatus(runtime, 'completed');
    runtime.lastCompletedTurnId = runtime.turnId;
    const event = notifyCompletion(runtime, completionId, runtime.baselinePending);
    runtime.baselinePending = false;
    runtime.baselineEstablished = true;
    emit(runtime);
    return event;
  }

  // L2 反向撤销入口（由 host 在收到「新的真实活动证据」时调用）：
  // store 侧 ingest 到新真实消息 / SQLite 变 active / 心跳新鲜时，若该会话正悬着完成候选，
  // 立即取消（不等 stabilizationMs 计时器），避免在 stop 后仍有活动的会话上误发完成。
  // 仅在确有「晚于 stop 时刻」的外部活动证据时才撤销；无 isLiveStill 注入时保守放行（保持原行为）。
  function revokePending(sessionId) {
    const runtime = sessions.get(String(sessionId || ''));
    if (!runtime || !runtime.pendingCompletion) return false;
    const sinceTs = runtime.candidateStopTs;
    if (isLiveStill && sinceTs && !isLiveStill(runtime.sessionId, sinceTs)) return false;
    const wasPending = cancelCandidate(runtime);
    if (wasPending) {
      setStatus(runtime, statusAfterActivity(runtime));
      emit(runtime);
    }
    return wasPending;
  }

  function rememberEvent(id) {
    if (seenEvents.has(id)) return false;
    seenEvents.add(id);
    seenEventOrder.push(id);
    if (seenEventOrder.length > MAX_SEEN_EVENTS) seenEvents.delete(seenEventOrder.shift());
    return true;
  }

  function enqueueFailure(runtime, failureId, failedAt, baseline, reason = null) {
    if (runtime.lastFailureNotificationId === failureId) return null;
    runtime.lastFailureNotificationId = failureId;
    const failure = { failureId, ...snapshot(runtime), failedAt, reason };
    failures.push(failure);
    if (!baseline) onFailure(failure);
    return failure;
  }

  function handleBackgroundTask(runtime, normalized, { baseline }) {
    if (!runtime.capabilities.backgroundTaskEvents) {
      onDiagnostic({ diagnostic: 'background-task-events-unavailable', event: normalized.event, sessionId: runtime.sessionId });
      return;
    }
    if (!normalized.task_id) {
      onDiagnostic({ diagnostic: 'background-task-missing-id', event: normalized.event, sessionId: runtime.sessionId });
      return;
    }
    establishTurnFromActivity(runtime, normalized, baseline);
    const existing = runtime.activeBackgroundTasks.get(normalized.task_id) || {
      taskId: normalized.task_id,
      toolUseId: normalized.tool_use_id,
      type: normalized.task_type,
      status: 'running',
      lastEventAt: normalized.ts,
    };
    existing.toolUseId ||= normalized.tool_use_id;
    existing.type ||= normalized.task_type;
    existing.lastEventAt = normalized.ts;
    const taskStatus = normalized.task_status;
    if (normalized.event === 'task_started' || normalized.event === 'task_progress') {
      cancelCandidate(runtime);
      clearNotificationWait(runtime);
      existing.status = 'running';
      runtime.activeBackgroundTasks.set(normalized.task_id, existing);
      setStatus(runtime, 'running');
      return;
    }
    if (taskStatus && TERMINAL_BACKGROUND_STATUSES.has(taskStatus)) {
      runtime.activeBackgroundTasks.delete(normalized.task_id);
      if (taskStatus === 'failed' || taskStatus === 'stopped') {
        cancelCandidate(runtime);
        setStatus(runtime, 'failed');
        enqueueFailure(
          runtime,
          `background:${normalized.event_id}`,
          normalized.ts,
          baseline,
          `background task ${taskStatus}`,
        );
      } else if (runtime.pendingCompletion) {
        scheduleCompletion(runtime);
      } else {
        setStatus(runtime, statusAfterActivity(runtime));
      }
      return;
    }
    cancelCandidate(runtime);
    clearNotificationWait(runtime);
    existing.status = taskStatus || 'running';
    runtime.activeBackgroundTasks.set(normalized.task_id, existing);
    setStatus(runtime, 'running');
  }

  function handle(input, { baseline = false } = {}) {
    const normalized = normalizeEvent(input, clock);
    if (normalized.diagnostic) {
      onDiagnostic(normalized);
      return null;
    }
    if (!rememberEvent(normalized.event_id)) {
      const duplicate = sessions.get(normalized.session_id);
      return duplicate ? snapshot(duplicate) : null;
    }
    const runtime = getOrCreate(normalized.session_id);
    runtime.lastEventAt = Math.max(runtime.lastEventAt, normalized.ts);
    runtime.lastEventType = normalized.event;
    if (normalized.transcript_path && runtime.capabilities.transcriptPath) runtime.transcriptPath = normalized.transcript_path;
    if (normalized.cwd) runtime.cwd = normalized.cwd;
    if (baseline) runtime.baselinePending = true;
    else if (normalized.event === 'SessionStart' || normalized.event === 'UserPromptSubmit') runtime.baselinePending = false;

    switch (normalized.event) {
      case 'SessionStart':
        cancelCandidate(runtime);
        runtime.turnId = null;
        runtime.turnIsCurrent = false;
        runtime.activeToolIds.clear();
        runtime.activeSubagentIds.clear();
        runtime.activeBackgroundTasks.clear();
        runtime.waitingForPermission = false;
        runtime.waitingForElicitation = false;
        runtime.waitingFromNotification = false;
        runtime.lastQuestionSignal = null;
        runtime.lastStopHookActive = null;
        setStatus(runtime, 'idle');
        break;
      case 'UserPromptSubmit':
        cancelCandidate(runtime);
        runtime.turnSequence += 1;
        runtime.turnId = `${runtime.sessionId}:${normalized.ts}:${runtime.turnSequence}`;
        runtime.turnIsCurrent = !baseline;
        runtime.activeToolIds.clear();
        runtime.activeSubagentIds.clear();
        runtime.activeBackgroundTasks.clear();
        runtime.waitingForPermission = false;
        runtime.waitingForElicitation = false;
        clearNotificationWait(runtime);
        runtime.lastQuestionSignal = null;
        runtime.lastStopHookActive = null;
        runtime.lastCompletedTurnId = null;
        setStatus(runtime, 'thinking');
        break;
      case 'PreToolUse':
        establishTurnFromActivity(runtime, normalized, baseline);
        cancelCandidate(runtime);
        clearNotificationWait(runtime);
        runtime.waitingForPermission = false;
        runtime.lastStopHookActive = null;
        runtime.activeToolIds.add(nextId(runtime, normalized.tool_use_id, 'tool', normalized.ts));
        setStatus(runtime, 'running_tool');
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
        removeOne(runtime.activeToolIds, normalized.tool_use_id);
        if (runtime.pendingCompletion) scheduleCompletion(runtime);
        else setStatus(runtime, statusAfterActivity(runtime));
        break;
      case 'PermissionRequest':
      case 'PermissionDenied':
        cancelCandidate(runtime);
        runtime.waitingForPermission = true;
        setStatus(runtime, 'waiting_user');
        break;
      case 'Elicitation':
        cancelCandidate(runtime);
        runtime.waitingForElicitation = true;
        setStatus(runtime, 'waiting_user');
        break;
      case 'ElicitationResult':
        runtime.waitingForElicitation = false;
        clearNotificationWait(runtime);
        setStatus(runtime, statusAfterActivity(runtime));
        break;
      case 'SubagentStart':
        establishTurnFromActivity(runtime, normalized, baseline);
        cancelCandidate(runtime);
        clearNotificationWait(runtime);
        runtime.activeSubagentIds.add(nextId(runtime, normalized.subagent_id, 'subagent', normalized.ts));
        setStatus(runtime, 'running_subagent');
        break;
      case 'SubagentStop':
        removeOne(runtime.activeSubagentIds, normalized.subagent_id);
        if (runtime.pendingCompletion) scheduleCompletion(runtime);
        else setStatus(runtime, statusAfterActivity(runtime));
        break;
      case 'Stop':
        runtime.lastStopAt = normalized.ts;
        runtime.lastQuestionSignal = normalized.ends_with_question === true;
        runtime.lastStopHookActive = normalized.stop_hook_active;
        if (!runtime.turnId || (!runtime.turnIsCurrent && !baseline)) {
          cancelCandidate(runtime);
          onDiagnostic({ diagnostic: 'stop-without-current-turn', sessionId: runtime.sessionId, ts: normalized.ts });
          setStatus(runtime, 'idle');
          break;
        }
        if (runtime.status === 'completed' && runtime.lastCompletedTurnId === runtime.turnId) break;
        if (normalized.stop_hook_active === true) {
          cancelCandidate(runtime);
          setStatus(runtime, statusAfterActivity(runtime));
          break;
        }
        if (runtime.waitingForPermission || runtime.waitingForElicitation || runtime.waitingFromNotification) {
          cancelCandidate(runtime);
          setStatus(runtime, 'waiting_user');
          break;
        }
        runtime.pendingCompletion = true;
        runtime.pendingSince = Number(clock());
        runtime.candidateStopTs = normalized.ts;
        setStatus(runtime, 'candidate_completion');
        scheduleCompletion(runtime);
        break;
      case 'StopFailure': {
        cancelCandidate(runtime);
        setStatus(runtime, 'failed');
        enqueueFailure(
          runtime,
          `stop-failure:${normalized.event_id}`,
          normalized.ts,
          baseline,
          normalized.reason,
        );
        break;
      }
      case 'Notification':
        if (mapNotificationType(normalized.notification_type)) {
          if (
            normalized.notification_type?.toLowerCase() === 'idle_prompt'
            && runtime.status === 'completed'
            && runtime.lastCompletedTurnId === runtime.turnId
          ) break;
          cancelCandidate(runtime);
          runtime.waitingFromNotification = true;
          setStatus(runtime, 'waiting_user');
        }
        break;
      case 'TaskCreated':
        cancelCandidate(runtime);
        clearNotificationWait(runtime);
        if (runtime.turnId) setStatus(runtime, 'running');
        break;
      case 'TaskCompleted':
        if (runtime.pendingCompletion) scheduleCompletion(runtime);
        break;
      case 'task_started':
      case 'task_progress':
      case 'task_updated':
      case 'task_notification':
        handleBackgroundTask(runtime, normalized, { baseline });
        break;
      case 'SessionEnd':
        cancelCandidate(runtime);
        runtime.turnId = null;
        runtime.turnIsCurrent = false;
        runtime.activeToolIds.clear();
        runtime.activeSubagentIds.clear();
        runtime.activeBackgroundTasks.clear();
        runtime.waitingForPermission = false;
        runtime.waitingForElicitation = false;
        runtime.waitingFromNotification = false;
        if (runtime.status !== 'completed' && runtime.status !== 'failed') setStatus(runtime, 'idle');
        break;
      default:
        break;
    }
    emit(runtime);
    return snapshot(runtime);
  }

  function handleBatch(events, { baseline = false } = {}) {
    for (const input of Array.isArray(events) ? events : []) handle(input, { baseline });
    if (baseline) {
      for (const runtime of sessions.values()) {
        runtime.baselineEstablished = true;
        if (runtime.pendingCompletion) confirmCompletion(runtime.sessionId, { force: true });
      }
    }
    return getAll();
  }

  function get(sessionId) {
    const runtime = sessions.get(String(sessionId || ''));
    return runtime ? snapshot(runtime) : undefined;
  }

  function getAll() {
    return [...sessions.values()].map(snapshot);
  }

  function reconcileStale() {
    const now = Number(clock()) || Date.now();
    let changed = 0;
    for (const runtime of sessions.values()) {
      if (!RUNNING_STATUSES.has(runtime.status)) continue;
      const threshold = Number(staleThresholds[runtime.status]);
      if (!runtime.lastEventAt || !Number.isFinite(threshold) || now - runtime.lastEventAt < threshold) continue;
      const previousStatus = runtime.status;
      cancelCandidate(runtime);
      setStatus(runtime, 'unknown');
      onDiagnostic({
        diagnostic: 'stale-runtime',
        sessionId: runtime.sessionId,
        previousStatus,
        lastEventAt: runtime.lastEventAt,
      });
      emit(runtime);
      changed++;
    }
    return changed;
  }

  function drainNotifications() {
    return notifications.splice(0);
  }

  function drainFailures() {
    return failures.splice(0);
  }

  function reset() {
    for (const runtime of sessions.values()) clearTimer(runtime);
    sessions.clear();
    seenEvents.clear();
    seenEventOrder.length = 0;
    notifications.length = 0;
    failures.length = 0;
  }

  return {
    handle,
    handleBatch,
    get,
    getAll,
    getCapabilities: () => ({ ...capabilities }),
    drainNotifications,
    drainFailures,
    reconcileStale,
    confirmCompletion,
    revokePending,
    reset,
  };
}

module.exports = {
  WORKBUDDY_EVENTS,
  BACKGROUND_TASK_EVENTS,
  WORKBUDDY_INTERNAL_STATES,
  DEFAULT_CAPABILITIES,
  COMPLETION_STABILIZATION_MS,
  PENDING_COMPLETION_MAX_MS,
  DEFAULT_STALE_THRESHOLDS,
  normalizeEvent,
  normalizeBackgroundStatus,
  mapNotificationType,
  makeCompletionId,
  createWorkBuddyMonitor,
};
