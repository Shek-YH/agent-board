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

  function lifecycleLiveValue(runtime) {
    if (runtime?.state_engine_mode === 'on' && typeof runtime.ui_status?.key === 'string') {
      if (['thinking', 'planning', 'using_tool', 'running_command', 'running_subagent', 'completion_candidate', 'compacting_context'].includes(runtime.ui_status.key)) return true;
      if (['waiting_approval', 'waiting_user', 'waiting_external', 'completed', 'failed', 'interrupted', 'rate_limited', 'session_closed'].includes(runtime.ui_status.key)) return false;
    }
    const lifecycle = String(runtime?.lifecycle_state || '').toUpperCase();
    if (lifecycle === 'ACTIVE' || lifecycle === 'COMPLETION_CANDIDATE') return true;
    if (['IDLE', 'WAITING_USER', 'COMPLETED', 'FAILED', 'INTERRUPTED'].includes(lifecycle)) return false;
    return null;
  }

  window.AgentBoardSessionLifecycleStatus = Object.freeze({ runtimeStatusValue, lifecycleLiveValue });
})();
