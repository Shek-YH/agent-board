'use strict';

const { TERMINAL_STATES } = require('./reducer');

function selectPublicState(state) { return state && state.publicState || 'UNKNOWN'; }
function isTerminal(state) { return TERMINAL_STATES.has(selectPublicState(state)); }
function selectCompletionCandidate(state) {
  return selectPublicState(state) === 'COMPLETION_CANDIDATE' ? state.completionCandidateAt : 0;
}
function selectRuntimeSnapshot(state) {
  return {
    publicState: selectPublicState(state),
    turnId: state && state.turnId || null,
    updatedAt: state && state.updatedAt || 0,
    terminalAt: state && state.terminalAt || 0,
    completionCandidateAt: selectCompletionCandidate(state),
    // 老化标记：publicState 是被 staleMs 兜底降级的（原始状态仍是 active/candidate）。
    // 供诊断区分「真的空闲」与「证据过期」，两者对外都是非 live。
    stale: Boolean(state && state.stale),
    topology: { ...(state && state.topology || {}) },
  };
}

module.exports = { selectPublicState, isTerminal, selectCompletionCandidate, selectRuntimeSnapshot };
