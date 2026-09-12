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
    topology: { ...(state && state.topology || {}) },
  };
}

module.exports = { selectPublicState, isTerminal, selectCompletionCandidate, selectRuntimeSnapshot };
