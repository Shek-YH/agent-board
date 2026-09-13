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
    const lifecycle = String(runtime?.lifecycle_state || '').toUpperCase();
    return lifecycleToRuntime[lifecycle] || (runtime && runtime.state) || '';
  }

  function lifecycleLiveValue(runtime) {
    const lifecycle = String(runtime?.lifecycle_state || '').toUpperCase();
    if (lifecycle === 'ACTIVE' || lifecycle === 'COMPLETION_CANDIDATE') return true;
    if (['IDLE', 'WAITING_USER', 'COMPLETED', 'FAILED', 'INTERRUPTED'].includes(lifecycle)) return false;
    return null;
  }

  window.AgentBoardSessionLifecycleStatus = Object.freeze({ runtimeStatusValue, lifecycleLiveValue });
})();
