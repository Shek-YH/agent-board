'use strict';

const KNOWN_AGENTS = new Set(['claude', 'codex', 'workbuddy', 'deepseek', 'marvis', 'zcode', 'pi', 'hermes']);

function normalizeSupervisorRequest(input = {}) {
  const projectPath = String(input.projectPath || '').trim();
  const goal = String(input.goal || '').trim();
  const mode = input.mode === 'global' ? 'global' : 'project';
  const agent = String(input.agent || '').trim();
  if (!projectPath) throw new Error('project path is required');
  if (!goal) throw new Error('goal is required');
  if (agent && !KNOWN_AGENTS.has(agent)) throw new Error('unsupported execution agent');
  return {
    projectPath, goal, mode, agent,
    requestedBy: String(input.requestedBy || 'jarvis'),
  };
}

module.exports = { KNOWN_AGENTS, normalizeSupervisorRequest };
