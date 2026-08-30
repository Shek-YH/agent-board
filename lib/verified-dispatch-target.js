'use strict';

function text(value) {
  return typeof value === 'string' ? value : String(value == null ? '' : value);
}

function normalizeProject(value) {
  return text(value).trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

function enrichVerifiedTarget(request = {}, resolution = {}) {
  if (!resolution || resolution.status !== 'resolved' || !resolution.target) return null;
  const targetRef = text(resolution.target.sessionRef || resolution.target.id).trim();
  if (!targetRef) return null;
  const directTarget = resolution.target;
  const candidate = Array.isArray(resolution.candidates)
    ? resolution.candidates.find((item) => (
      item && text(item.sessionRef || item.id).trim() === targetRef
    ))
    : directTarget;
  if (!candidate) return null;

  const requestedAgent = text(request.agent).trim().toLowerCase();
  const candidateAgent = text(candidate.agent).trim().toLowerCase();
  if (!candidateAgent || (requestedAgent && candidateAgent !== requestedAgent)) return null;

  const requestedProject = normalizeProject(request.project);
  const candidateProject = text(candidate.project).trim();
  if (requestedProject && (!candidateProject || normalizeProject(candidateProject) !== requestedProject)) return null;
  const title = text(candidate.title || resolution.target.title).trim();

  const role = text(candidate.role || candidate.sessionRole || candidate.session_role
    || resolution.target.role || resolution.target.sessionRole || resolution.target.session_role).trim().toLowerCase();
  const controlEligibility = text(candidate.controlEligibility || candidate.control_eligibility
    || resolution.target.controlEligibility || resolution.target.control_eligibility).trim().toLowerCase();
  if (role !== 'main' || controlEligibility !== 'eligible') return null;

  return {
    ...resolution.target,
    sessionRef: targetRef,
    agent: candidateAgent,
    ...(candidateProject ? { project: candidateProject } : {}),
    ...(title ? { title } : {}),
    role,
    controlEligibility,
  };
}

module.exports = { enrichVerifiedTarget, normalizeProject };
