'use strict';

const { enrichVerifiedTarget } = require('../../verified-dispatch-target');

async function runPreflightSession({ workflow, dependencies } = {}) {
  if (!dependencies || typeof dependencies.resolveSession !== 'function' || typeof dependencies.verifySession !== 'function') return null;
  const binding = workflow && workflow.binding || {};
  if (!binding.sessionRef) return null;
  try {
    const request = {
      agent: workflow.agent,
      project: binding.projectPath,
      sessionRef: binding.sessionRef,
      title: binding.title,
      message: '',
    };
    const resolution = await dependencies.resolveSession(request, { phase: 'PREFLIGHT' });
    const target = enrichVerifiedTarget(request, resolution);
    if (!target) return null;
    const verification = await dependencies.verifySession(target, { request, resolution, phase: 'PREFLIGHT' });
    if (!verification || verification.strongAnchor !== true) return null;
    return { ...target, ...verification };
  } catch {
    return null;
  }
}

module.exports = { runPreflightSession };
