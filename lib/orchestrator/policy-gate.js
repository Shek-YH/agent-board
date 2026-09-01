'use strict';

const { isInsideRoot } = require('./project-lifecycle');
const { verifyPermissionSnapshot } = require('./permission-snapshot');

const DANGEROUS_PATTERNS = [
  /\bgit\s+push\b/i, /\b(?:rm|rmdir|del|erase)\s+-?r?f?\b/i, /\b(?:drop|truncate)\s+(?:table|database)\b/i,
  /\bdeploy(?:ment)?\s+(?:to\s+)?production\b/i, /\bsudo\b/i,
];

function pass(name, detail = '') { return { name, status: 'pass', ...(detail ? { detail } : {}) }; }
function fail(name, reason, reasonCode) { return { name, status: 'fail', reason, reasonCode }; }

function permissionAllows(snapshot, capability) {
  return Boolean(snapshot && snapshot[`allow${capability}`] === true);
}

function networkHosts(instruction) {
  return [...String(instruction || '').matchAll(/https?:\/\/([^/\s:'"]+)/ig)].map((match) => match[1].toLowerCase());
}

function networkDomainAllowed(host, domains) {
  return domains.some((domain) => {
    const normalized = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
    return normalized === '*' || host === normalized || host.endsWith(`.${normalized}`);
  });
}

function evaluatePolicyGate({ workflow, capabilities = {}, session, instruction = '', watchdog, allowedRoots = [] } = {}) {
  if (!workflow || typeof workflow !== 'object') throw new TypeError('workflow is required');
  const checks = [];
  if (workflow.autopilotMode !== 'auto') checks.push(fail('mode', 'workflow is not auto', 'AUTO_REQUIRED'));
  else checks.push(pass('mode'));

  if (workflow.controlOwner === 'human') checks.push(fail('human_override', 'human control has priority', 'NEED_HUMAN'));
  else checks.push(pass('human_override'));

  const binding = workflow.binding || {};
  if (!binding.sessionRef || !binding.agent || !binding.projectPath) checks.push(fail('binding', 'single-session binding is required', 'IDENTITY_UNVERIFIED'));
  else checks.push(pass('binding'));

  const sameProject = binding.projectPath && workflow.projectPath
    && String(binding.projectPath).toLowerCase() === String(workflow.projectPath).toLowerCase();
  const inAllowedRoot = Boolean(binding.projectPath)
    && (!allowedRoots.length || allowedRoots.some((root) => isInsideRoot(binding.projectPath, root)));
  const storedSnapshot = workflow.permissionSnapshot || null;
  const snapshot = storedSnapshot || { allowedWriteRoots: [workflow.projectPath] };
  const inSnapshotRoot = Boolean(snapshot && binding.projectPath && Array.isArray(snapshot.allowedWriteRoots)
    && snapshot.allowedWriteRoots.some((root) => isInsideRoot(binding.projectPath, root)));
  checks.push(sameProject && inAllowedRoot && inSnapshotRoot
    ? pass('scope')
    : fail('scope', 'session binding must remain inside the pre-authorized project scope', storedSnapshot ? 'NEED_HUMAN_SCOPE' : 'SCOPE_INVALID'));
  checks.push(!storedSnapshot || verifyPermissionSnapshot(storedSnapshot)
    ? pass('permission_snapshot')
    : fail('permission_snapshot', 'permission snapshot is invalid', 'NEED_HUMAN_PERMISSION_SNAPSHOT'));

  const capabilityNames = ['sessionIdentity', 'completionDetector', 'messageWriter', 'deliveryVerifier', 'verifiedDispatch'];
  for (const name of capabilityNames) {
    if (capabilities[name] !== true) checks.push(fail(name, `${name} capability is unavailable`, 'CAPABILITY_UNAVAILABLE'));
    else checks.push(pass(name));
  }

  const sameBinding = session && session.sessionRef === binding.sessionRef
    && (!session.agent || session.agent === binding.agent)
    && (!session.project || session.project === binding.projectPath)
    && session.strongAnchor === true && session.role === 'main' && session.controlEligibility === 'eligible';
  checks.push(sameBinding ? pass('session') : fail('session', 'strong eligible session identity is required', 'IDENTITY_UNVERIFIED'));

  const instructionText = String(instruction || '');
  // Supervisor instructions include an explicit "范围外" safety reminder. It is
  // policy metadata, not an operation request; scanning it would mistake the
  // words Token/.env/Git Push in the prohibition list for an active command.
  const operationalInstruction = instructionText.split(/\r?\n/)
    .filter((line) => !/^\s*(?:范围外：|不要执行范围外)/.test(line))
    .join('\n');
  const dangerous = DANGEROUS_PATTERNS.some((pattern) => pattern.test(operationalInstruction));
  const secretAccess = /(?:\.env(?:\.|\b)|(?:api[_ -]?key|token|password|private[_ -]?key))/i.test(operationalInstruction);
  const networkAccess = /(?:curl|wget|invoke-webrequest|联网|网络请求|http[s]?:\/\/)/i.test(operationalInstruction);
  const installAccess = /(?:npm\s+(?:install|i)|pnpm\s+(?:install|i)|yarn\s+add|pip\s+install|cargo\s+add|安装依赖)/i.test(operationalInstruction);
  const gitPush = /\bgit\s+push\b/i.test(operationalInstruction);
  const allowedDomains = Array.isArray(snapshot.allowedNetworkDomains) ? snapshot.allowedNetworkDomains : [];
  const hosts = networkHosts(operationalInstruction);
  const networkAuthorized = permissionAllows(snapshot, 'Network')
    && (hosts.length ? hosts.every((host) => networkDomainAllowed(host, allowedDomains)) : allowedDomains.includes('*'));
  const blockedBySnapshot = secretAccess
    || (networkAccess && !networkAuthorized)
    || (installAccess && !permissionAllows(snapshot, 'Install'))
    || gitPush;
  const dangerousWithoutAuthorization = dangerous;
  checks.push(dangerousWithoutAuthorization || blockedBySnapshot
    ? fail('danger', 'instruction exceeds the pre-authorized permission snapshot', 'PERMISSION_REQUIRED') : pass('danger'));

  const watchdogResult = watchdog || { allowed: false, reason: 'Budget Exceeded', reasonCode: 'WATCHDOG_BLOCKED' };
  const watchdogCode = watchdogResult.reasonCode
    || (watchdogResult.reason === 'Duplicate Instruction' ? 'DUPLICATE_INSTRUCTION' : 'WATCHDOG_BLOCKED');
  checks.push(watchdogResult.allowed ? pass('watchdog') : fail('watchdog', watchdogResult.reason || 'watchdog blocked', watchdogCode));

  const firstFailure = checks.find((item) => item.status === 'fail');
  return {
    allowed: !firstFailure,
    reason: firstFailure ? firstFailure.reason : null,
    reasonCode: firstFailure ? firstFailure.reasonCode : null,
    checks,
  };
}

module.exports = { DANGEROUS_PATTERNS, evaluatePolicyGate };
