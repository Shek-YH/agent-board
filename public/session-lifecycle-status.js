'use strict';

(() => {
  const lifecycleToRuntime = Object.freeze({
    UNKNOWN: 'unknown',
    IDLE: 'idle',
    ACTIVE: 'running',
    WAITING_USER: 'waiting_user_input',
    COMPLETION_CANDIDATE: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    INTERRUPTED: 'interrupted',
  });

  function runtimeStatusValue(runtime) {
    if (runtime?.state_engine_mode === 'on' && typeof runtime.ui_status?.key === 'string') return runtime.ui_status.key;
    const lifecycle = String(runtime?.lifecycle_state || '').toUpperCase();
    return lifecycleToRuntime[lifecycle] || (runtime && runtime.state) || '';
  }

  // lifecycle_state 是「软」证据（事件驱动、可能落后）。它可以确认「活着」，
  // 但不能在权威 liveRefs/state 已判定完成时把会话拉回进行中；
  // 后端 engine 已按 staleMs 老化，这里再兜一层：只把 ACTIVE/COMPLETION_CANDIDATE 当作 live。
  function lifecycleLiveValue(runtime) {
    if (runtime?.state_engine_mode === 'on' && typeof runtime.ui_status?.key === 'string') {
      if (['thinking', 'planning', 'using_tool', 'running_command', 'running_subagent', 'compaction', 'compacting_context'].includes(runtime.ui_status.key)) return true;
      if (['waiting_approval', 'waiting_user', 'waiting_external', 'completed', 'failed', 'interrupted', 'rate_limited', 'session_closed', 'completion_candidate'].includes(runtime.ui_status.key)) return false;
    }
    // 终态优先：显式 completed/failed/interrupted 一律非 live，无论 lifecycle_state 说什么。
    const state = String(runtime?.state || '').toLowerCase();
    if (['completed', 'failed', 'interrupted', 'session_closed'].includes(state)) return false;
    const lifecycle = String(runtime?.lifecycle_state || '').toUpperCase();
    if (lifecycle === 'ACTIVE' || lifecycle === 'COMPLETION_CANDIDATE') return true;
    if (['IDLE', 'WAITING_USER', 'COMPLETED', 'FAILED', 'INTERRUPTED'].includes(lifecycle)) return false;
    return null;
  }

  window.AgentBoardSessionLifecycleStatus = Object.freeze({ runtimeStatusValue, lifecycleLiveValue });
})();
