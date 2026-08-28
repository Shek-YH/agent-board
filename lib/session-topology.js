'use strict';

const AGENT_TOPOLOGY_CAPABILITIES = {
  claude: {
    childDetection: 'verified',
    defaultRole: 'main',
    defaultControl: 'eligible',
    evidence: ['subagents path', 'agentId', 'isSidechain'],
  },
  zcode: {
    childDetection: 'verified',
    defaultRole: 'main',
    defaultControl: 'eligible',
    evidence: ['session.task_type'],
  },
  codex: {
    childDetection: 'verified',
    defaultRole: 'main',
    defaultControl: 'eligible',
    evidence: ['session_meta.payload.source.subagent.thread_spawn', 'parent_thread_id', 'thread_source'],
  },
  deepseek: {
    childDetection: 'verified',
    defaultRole: 'main',
    defaultControl: 'eligible',
    evidence: ["origin='subagent'", 'subagent/descriptor', 'parentSession'],
  },
  workbuddy: {
    childDetection: 'verified',
    defaultRole: 'main',
    defaultControl: 'eligible',
    evidence: ['subagents path', 'child UUID'],
  },
  marvis: {
    childDetection: 'verified',
    defaultRole: 'main',
    defaultControl: 'eligible',
    evidence: ['messages.metadata.subagent.id'],
  },
  pi: {
    childDetection: 'verified',
    defaultRole: 'main',
    defaultControl: 'eligible',
    evidence: ['subagents path'],
  },
  hermes: {
    childDetection: 'verified',
    defaultRole: 'main',
    defaultControl: 'eligible',
    evidence: ['exact delegate_task call/result projection'],
  },
};

const ROLE_VALUES = new Set(['main', 'child', 'unknown']);
const SOURCE_WEIGHT = { unsupported: 1, structural: 2, explicit: 3, manual: 4 };

function capabilityFor(agent) {
  return AGENT_TOPOLOGY_CAPABILITIES[agent] || {
    childDetection: 'unsupported', defaultRole: 'unknown', defaultControl: 'unknown', evidence: [],
  };
}

function asAgentRef(agent, value) {
  if (!value) return '';
  const raw = String(value);
  return raw.startsWith(`${agent}:`) ? raw : `${agent}:${raw}`;
}

function normalizeTopologyMessage(msg = {}) {
  const agent = String(msg.agent || 'other');
  const sessionId = String(msg.sessionId || '');
  const capability = capabilityFor(agent);
  const explicitRole = msg.sessionRole || msg.topologyRole;
  const role = ROLE_VALUES.has(explicitRole)
    ? explicitRole
    : capability.defaultRole;
  const parent = asAgentRef(agent, msg.parentSessionRef || msg.parentSessionId);
  const ownRef = asAgentRef(agent, sessionId);
  const root = asAgentRef(agent, msg.rootSessionRef || msg.rootSessionId)
    || (role === 'child' ? parent : ownRef);
  const source = SOURCE_WEIGHT[msg.topologySource] ? msg.topologySource
    : (explicitRole ? 'explicit' : (capability.childDetection === 'verified' ? 'structural' : 'unsupported'));
  const confidenceValue = Number(msg.topologyConfidence);
  const confidence = Number.isFinite(confidenceValue)
    ? Math.max(0, Math.min(1, confidenceValue))
    : (role === 'unknown' ? 0 : source === 'unsupported' ? 0.5 : 1);
  const detection = msg.childDetection === 'verified' || msg.childDetection === 'unsupported'
    ? msg.childDetection : capability.childDetection;
  let control = msg.controlEligibility;
  if (!['eligible', 'manual_only', 'blocked', 'unknown'].includes(control)) {
    control = role === 'child' ? 'blocked' : role === 'main' ? capability.defaultControl : 'unknown';
  }
  if (role === 'child') control = 'blocked';
  return {
    session_role: role,
    parent_session_ref: parent || null,
    root_session_ref: root || null,
    topology_source: source,
    topology_confidence: confidence,
    child_detection: detection,
    control_eligibility: control,
  };
}

function mergeTopology(session = {}, incoming = {}) {
  const currentSource = session.topology_source || 'unsupported';
  const incomingSource = incoming.topology_source || currentSource;
  const currentRole = ROLE_VALUES.has(session.session_role) ? session.session_role : 'unknown';
  const incomingRole = ROLE_VALUES.has(incoming.session_role) ? incoming.session_role : currentRole;
  const currentWeight = SOURCE_WEIGHT[currentSource] || 0;
  const incomingWeight = SOURCE_WEIGHT[incomingSource] || 0;
  const preserveChild = currentRole === 'child' && incomingRole !== 'child';
  const useIncoming = incomingWeight >= currentWeight || currentRole === 'unknown';
  const role = preserveChild ? 'child' : useIncoming ? incomingRole : currentRole;
  const parent = session.parent_session_ref || incoming.parent_session_ref || null;
  const root = session.root_session_ref || incoming.root_session_ref || null;
  const source = preserveChild || !useIncoming ? currentSource : incomingSource;
  const confidence = preserveChild || !useIncoming
    ? Number(session.topology_confidence || 0)
    : Number(incoming.topology_confidence || 0);
  const detection = session.child_detection === 'verified' || incoming.child_detection === 'verified'
    ? 'verified' : session.child_detection || incoming.child_detection || 'unsupported';
  const control = role === 'child' ? 'blocked'
    : (preserveChild || !useIncoming ? (session.control_eligibility || 'unknown') : (incoming.control_eligibility || 'unknown'));
  return {
    session_role: role,
    parent_session_ref: parent,
    root_session_ref: root,
    topology_source: source,
    topology_confidence: confidence,
    child_detection: detection,
    control_eligibility: control,
  };
}

function normalizeProject(value) {
  return String(value || '').trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

function isRecent(session, now, windowMs = 10 * 60 * 1000) {
  const lastSeen = Number(session.last_seen || session.lastActivity || 0);
  return lastSeen > 0 && now - lastSeen < windowMs;
}

function summarizeTopology(sessions = [], now = Date.now()) {
  const out = new Map();
  for (const session of sessions) {
    if (session.session_role !== 'child' || !session.parent_session_ref) continue;
    const current = out.get(session.parent_session_ref) || { child_count: 0, active_child_count: 0 };
    current.child_count += 1;
    if (isRecent(session, now)) current.active_child_count += 1;
    out.set(session.parent_session_ref, current);
  }
  return out;
}

function publicCandidate(session) {
  return {
    sessionRef: session.id,
    agent: session.agent,
    project: session.project || '',
    title: session.title || '',
    role: session.session_role || 'unknown',
    controlEligibility: session.control_eligibility || 'unknown',
    topologySource: session.topology_source || 'unsupported',
    topologyConfidence: Number(session.topology_confidence || 0),
    parentSessionRef: session.parent_session_ref || null,
    rootSessionRef: session.root_session_ref || null,
  };
}

function resolveControlTarget(sessions = [], { agent = '', project = '', sessionRef = '' } = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  if (sessionRef) {
    const exact = list.find((session) => session.id === sessionRef);
    if (!exact) return { status: 'not_found', target: null, candidates: [], evidence: [], reason: '指定 session 不存在' };
    if (exact.session_role === 'child') {
      return {
        status: 'blocked', target: null, candidates: [publicCandidate(exact)], evidence: [],
        reason: '子代理只能作为观察证据，不能作为主会话指令目标',
      };
    }
    if (exact.control_eligibility !== 'eligible') {
      return {
        status: 'blocked', target: null, candidates: [publicCandidate(exact)], evidence: [],
        reason: `会话控制资格为 ${exact.control_eligibility || 'unknown'}`,
      };
    }
    return {
      status: 'resolved', target: { sessionRef: exact.id, role: 'main' },
      candidates: [publicCandidate(exact)], evidence: ['explicit sessionRef'], reason: '已按明确 session ref 定位主会话',
    };
  }

  const wantedProject = normalizeProject(project);
  const candidates = list.filter((session) => {
    if (session.session_role !== 'main' || session.control_eligibility !== 'eligible') return false;
    if (agent && session.agent !== agent) return false;
    return !wantedProject || normalizeProject(session.project) === wantedProject;
  });
  const publicCandidates = candidates.map(publicCandidate);
  if (!candidates.length) {
    const blocked = list.filter((session) => {
      if (agent && session.agent !== agent) return false;
      return !wantedProject || normalizeProject(session.project) === wantedProject;
    });
    return {
      status: blocked.some((session) => session.session_role === 'child' || session.session_role === 'main') ? 'blocked' : 'not_found',
      target: null,
      candidates: blocked.map(publicCandidate),
      evidence: [],
      reason: blocked.length ? '没有满足自动控制资格的唯一主会话' : '没有匹配的 session',
    };
  }
  if (candidates.length > 1) {
    return { status: 'ambiguous', target: null, candidates: publicCandidates, evidence: [], reason: '匹配到多个主会话，禁止静默选择最近会话' };
  }
  const one = candidates[0];
  return {
    status: 'resolved', target: { sessionRef: one.id, role: 'main' }, candidates: publicCandidates,
    evidence: ['role=main', 'control_eligibility=eligible'], reason: '已唯一定位可控主会话',
  };
}

module.exports = {
  AGENT_TOPOLOGY_CAPABILITIES,
  normalizeTopologyMessage,
  mergeTopology,
  summarizeTopology,
  resolveControlTarget,
  capabilityFor,
};
