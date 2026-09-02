'use strict';

const { enrichVerifiedTarget } = require('./verified-dispatch-target');

const SUPPORTED_AGENTS = new Set(['codex', 'hermes', 'claude', 'workbuddy']);
const lockTails = new Map();

function text(value) {
  return typeof value === 'string' ? value : String(value == null ? '' : value);
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function okResult(value) {
  return isObject(value) && value.ok === true;
}

function strongAnchor(value) {
  return okResult(value) && value.strongAnchor === true && text(value.anchor).trim().length > 0;
}

function publicReason(value, fallback) {
  if (isObject(value) && value.reason) return text(value.reason);
  if (isObject(value) && value.error) return text(value.error);
  return fallback;
}

function sameTarget(left, right) {
  return !!left && !!right
    && text(left.sessionRef || left.id) === text(right.sessionRef || right.id)
    && (!left.agent || !right.agent || left.agent === right.agent);
}

function normalizeProject(value) {
  return text(value).trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

function resolutionCandidate(resolution, target) {
  const sessionRef = text(target && (target.sessionRef || target.id)).trim();
  if (!isObject(resolution) || !Array.isArray(resolution.candidates) || !sessionRef) return null;
  return resolution.candidates.find((candidate) => (
    text(candidate && (candidate.sessionRef || candidate.id)).trim() === sessionRef
  )) || null;
}

function validateResolvedTarget(resolution, input) {
  const target = isObject(resolution) ? resolution.target : null;
  if (!target) return { code: 'SESSION_NOT_RESOLVED', reason: '目标会话未唯一解析' };

  const candidate = resolutionCandidate(resolution, target) || {};
  const sessionRef = text(target.sessionRef || target.id || candidate.sessionRef || candidate.id).trim();
  const agent = text(target.agent || candidate.agent).trim().toLowerCase();
  const project = text(target.project || candidate.project).trim();
  const role = text(target.role || target.sessionRole || target.session_role
    || candidate.role || candidate.sessionRole || candidate.session_role).trim().toLowerCase();
  const eligibility = text(target.controlEligibility || target.control_eligibility
    || candidate.controlEligibility || candidate.control_eligibility).trim().toLowerCase();

  if (!sessionRef) return { code: 'SESSION_NOT_RESOLVED', reason: '目标会话缺少 session identity' };
  if (input.sessionRef && sessionRef !== input.sessionRef) {
    return { code: 'SESSION_IDENTITY_MISMATCH', reason: '解析出的 session 与请求目标不一致' };
  }
  if (agent && agent !== input.agent) {
    return { code: 'SESSION_IDENTITY_MISMATCH', reason: '解析出的 Agent 与请求目标不一致' };
  }
  if (input.project && project && normalizeProject(project) !== normalizeProject(input.project)) {
    return { code: 'SESSION_IDENTITY_MISMATCH', reason: '解析出的项目与请求目标不一致' };
  }
  if (role === 'child') return { code: 'TARGET_NOT_ELIGIBLE', reason: '子会话不能作为指令目标' };
  if (role !== 'main' || eligibility !== 'eligible') {
    return { code: 'TARGET_NOT_ELIGIBLE', reason: '目标会话不是可自动控制的 eligible 主会话' };
  }
  return null;
}

async function acquireLock(key) {
  const previous = lockTails.get(key) || Promise.resolve();
  let releaseCurrent;
  const current = new Promise((resolve) => { releaseCurrent = resolve; });
  lockTails.set(key, current);
  await previous;
  return () => {
    if (lockTails.get(key) === current) lockTails.delete(key);
    releaseCurrent();
  };
}

function normalizeRequest(request) {
  const input = isObject(request) ? request : {};
  const agent = text(input.agent).trim().toLowerCase();
  const message = text(input.message);
  return {
    agent,
    project: text(input.project).trim(),
    sessionRef: text(input.sessionRef).trim(),
    title: text(input.title).trim().slice(0, 300),
    message,
    idempotencyKey: text(input.idempotencyKey).trim(),
  };
}

function createResult(phases, evidence, fields = {}) {
  return { phases, evidence, ...fields };
}

/**
 * Execute one fail-closed GUI dispatch. Every dependency is intentionally
 * injected so the orchestration contract can be tested without a desktop.
 */
async function dispatchVerifiedMessage(request, dependencies = {}) {
  const input = normalizeRequest(request);
  const phases = [];
  const evidence = {};
  let currentPhase = 'PREPARE';
  let release = null;
  let sendAttempted = false;
  let target = null;
  let firstVerification = null;
  let deliverySnapshot = dependencies.deliverySnapshot;

  const record = (phase, status, value) => {
    const item = { phase, status };
    if (value !== undefined) {
      evidence[phase] = value;
      item.evidence = value;
    }
    phases.push(item);
  };

  const fail = (phase, code, reason, options = {}) => {
    record(phase, 'failed', { code, reason });
    return createResult(phases, evidence, {
      ok: false,
      status: options.status || (options.reconciliationRequired ? 'reconciliation_required' : 'failed'),
      phase,
      failure: { code, reason },
      reconciliationRequired: options.reconciliationRequired === true,
    });
  };

  try {
    if (!SUPPORTED_AGENTS.has(input.agent)) {
      return fail('PREPARE', 'UNSUPPORTED_AGENT', '当前 Agent 没有可用的 Verified Dispatch capability');
    }
    if (!input.message.trim()) {
      return fail('PREPARE', 'EMPTY_MESSAGE', '消息不能为空');
    }
    if (!input.sessionRef && !input.project) {
      return fail('PREPARE', 'MISSING_TARGET_LOCATOR', '必须提供 sessionRef 或 project 目标定位器');
    }
    if (typeof dependencies.resolveSession !== 'function'
      || typeof dependencies.verifySession !== 'function'
      || typeof dependencies.activateSession !== 'function'
      || !isObject(dependencies.writer)
      || typeof dependencies.writer.write !== 'function'
      || typeof dependencies.writer.send !== 'function'
      || typeof dependencies.verifyDraft !== 'function'
      || typeof dependencies.verifyDelivery !== 'function') {
      return fail('PREPARE', 'MISSING_DEPENDENCY', 'Verified Dispatch 依赖未完整提供');
    }
    record('PREPARE', 'ok', {
      agent: input.agent,
      project: input.project,
      sessionRef: input.sessionRef || null,
      messageLength: input.message.length,
    });

    // Serialize the whole Agent's GUI surface so sessionRef/project aliases
    // cannot bypass one another before the canonical session is known.
    const lockKey = `agent:${input.agent}`;
    currentPhase = 'LOCK';
    release = await acquireLock(lockKey);
    record('LOCK', 'ok', { key: lockKey });

    currentPhase = 'RESOLVE_SESSION';
    let resolution;
    try {
      resolution = await dependencies.resolveSession(input, { phase: currentPhase });
    } catch (error) {
      return fail(currentPhase, 'SESSION_NOT_RESOLVED', publicReason(error, '无法解析目标会话'));
    }
    if (!isObject(resolution) || resolution.status !== 'resolved' || !isObject(resolution.target)) {
      return fail(currentPhase, 'SESSION_NOT_RESOLVED', publicReason(resolution, '目标会话未唯一解析'), { status: 'blocked' });
    }
    const targetFailure = validateResolvedTarget(resolution, input);
    if (targetFailure) {
      return fail(currentPhase, targetFailure.code, targetFailure.reason, { status: 'blocked' });
    }
    target = enrichVerifiedTarget(input, resolution);
    if (!target) {
      return fail(currentPhase, 'SESSION_TARGET_INCOMPLETE', '解析出的会话缺少可靠的 Agent/项目/控制资格证据', { status: 'blocked' });
    }
    const enrichedResolution = { ...resolution, target };
    record(currentPhase, 'ok', enrichedResolution);

    let preparedActivation = null;
    if (typeof dependencies.prepareSession === 'function') {
      currentPhase = 'PREPARE_SESSION';
      let preparation;
      try {
        preparation = await dependencies.prepareSession(target, {
          request: input, resolution: enrichedResolution, phase: currentPhase,
        });
      } catch (error) {
        return fail(currentPhase, 'ACTIVATION_FAILED', publicReason(error, '无法准备目标会话'));
      }
      if (!okResult(preparation)) {
        return fail(currentPhase, 'ACTIVATION_FAILED', publicReason(preparation, '目标会话准备失败'));
      }
      preparedActivation = preparation;
      record(currentPhase, 'ok', preparation);
    }

    currentPhase = 'VERIFY_SESSION';
    try {
      firstVerification = await dependencies.verifySession(target, { request: input, resolution: enrichedResolution, phase: currentPhase });
    } catch (error) {
      return fail(currentPhase, 'SESSION_IDENTITY_UNVERIFIED', publicReason(error, '无法验证目标会话身份'));
    }
    if (!strongAnchor(firstVerification)) {
      return fail(currentPhase, 'SESSION_IDENTITY_UNVERIFIED', publicReason(firstVerification, '缺少强会话身份锚点'), { status: 'blocked' });
    }
    record(currentPhase, 'ok', firstVerification);

    currentPhase = 'ACTIVATE';
    let activation = preparedActivation;
    if (!activation) {
      try {
        activation = await dependencies.activateSession(target, { request: input, resolution: enrichedResolution, verification: firstVerification, phase: currentPhase });
      } catch (error) {
        return fail(currentPhase, 'ACTIVATION_FAILED', publicReason(error, '无法激活目标会话'));
      }
      if (!okResult(activation)) {
        return fail(currentPhase, 'ACTIVATION_FAILED', publicReason(activation, '目标会话激活失败'));
      }
    }
    record(currentPhase, 'ok', activation);

    currentPhase = 'RE_VERIFY_SESSION';
    let reResolution;
    try {
      reResolution = await dependencies.resolveSession(input, { phase: currentPhase, afterActivation: true });
    } catch (error) {
      return fail(currentPhase, 'IDENTITY_DRIFT', publicReason(error, '激活后无法重新解析目标会话'), { status: 'blocked' });
    }
    const reTargetFailure = validateResolvedTarget(reResolution, input);
    if (reTargetFailure) {
      return fail(currentPhase, reTargetFailure.code === 'TARGET_NOT_ELIGIBLE'
        ? reTargetFailure.code : 'IDENTITY_DRIFT', reTargetFailure.reason, { status: 'blocked' });
    }
    const enrichedReTarget = enrichVerifiedTarget(input, reResolution);
    if (!enrichedReTarget || !isObject(reResolution) || reResolution.status !== 'resolved' || !sameTarget(target, enrichedReTarget)) {
      return fail(currentPhase, 'IDENTITY_DRIFT', '激活后目标会话发生变化', { status: 'blocked' });
    }
    reResolution = { ...reResolution, target: enrichedReTarget };
    let secondVerification;
    try {
      secondVerification = await dependencies.verifySession(reResolution.target, {
        request: input,
        resolution: reResolution,
        previousVerification: firstVerification,
        phase: currentPhase,
      });
    } catch (error) {
      return fail(currentPhase, 'IDENTITY_DRIFT', publicReason(error, '激活后无法验证目标会话身份'), { status: 'blocked' });
    }
    if (!strongAnchor(secondVerification)
      || (firstVerification.anchor && secondVerification.anchor && firstVerification.anchor !== secondVerification.anchor)) {
      return fail(currentPhase, 'IDENTITY_DRIFT', publicReason(secondVerification, '激活后强会话身份锚点不一致'), { status: 'blocked' });
    }
    target = reResolution.target;
    if (typeof dependencies.captureDeliverySnapshot === 'function') {
      try {
        deliverySnapshot = await dependencies.captureDeliverySnapshot(target, {
          request: input,
          resolution: reResolution,
          verification: secondVerification,
          phase: currentPhase,
        });
      } catch (error) {
        return fail(currentPhase, 'DELIVERY_SNAPSHOT_FAILED', publicReason(error, '无法建立发送前送达快照'), { status: 'blocked' });
      }
      if (deliverySnapshot === undefined || deliverySnapshot === null) {
        return fail(currentPhase, 'DELIVERY_SNAPSHOT_FAILED', '发送前送达快照为空', { status: 'blocked' });
      }
      evidence.DELIVERY_SNAPSHOT = deliverySnapshot;
    }
    record(currentPhase, 'ok', { resolution: reResolution, verification: secondVerification, ...(deliverySnapshot ? { deliverySnapshot } : {}) });

    currentPhase = 'WRITE';
    let written;
    try {
      written = await dependencies.writer.write(target, input.message, {
        request: input,
        resolution: reResolution,
        verification: secondVerification,
        snapshot: deliverySnapshot,
        phase: currentPhase,
      });
    } catch (error) {
      return fail(currentPhase, 'WRITE_FAILED', publicReason(error, '无法写入消息草稿'));
    }
    if (!okResult(written)) {
      return fail(currentPhase, isObject(written) && written.code ? text(written.code) : 'WRITE_FAILED', publicReason(written, '消息草稿写入失败'));
    }
    if (written.matches === false) {
      return fail(currentPhase, 'DRAFT_MISMATCH', publicReason(written, '草稿即时读回与目标消息不一致'));
    }
    record(currentPhase, 'ok', written);

    currentPhase = 'VERIFY_DRAFT';
    let draftVerification;
    try {
      draftVerification = await dependencies.verifyDraft(target, input.message, {
        request: input,
        resolution: reResolution,
        verification: secondVerification,
        written,
        snapshot: deliverySnapshot,
        phase: currentPhase,
      });
    } catch (error) {
      return fail(currentPhase, 'DRAFT_MISMATCH', publicReason(error, '草稿读回失败'));
    }
    if (!okResult(draftVerification) || draftVerification.matches !== true) {
      return fail(currentPhase, isObject(draftVerification) && draftVerification.code ? text(draftVerification.code) : 'DRAFT_MISMATCH', publicReason(draftVerification, '草稿读回与目标消息不一致'));
    }
    record(currentPhase, 'ok', draftVerification);

    currentPhase = 'SEND';
    let sent;
    sendAttempted = true;
    try {
      sent = await dependencies.writer.send(target, {
        request: input,
        resolution: reResolution,
        verification: secondVerification,
        draftVerification,
        snapshot: deliverySnapshot,
        phase: currentPhase,
      });
    } catch (error) {
      return fail(currentPhase, 'SEND_FAILED', publicReason(error, '发送状态不确定，需对账'), { reconciliationRequired: true });
    }
    if (!okResult(sent)) {
      return fail(currentPhase, isObject(sent) && sent.code ? text(sent.code) : 'SEND_FAILED', publicReason(sent, '发送失败'), {
        reconciliationRequired: true,
      });
    }
    record(currentPhase, 'ok', sent);

    currentPhase = 'VERIFY_DELIVERY';
    let delivery;
    try {
      delivery = await dependencies.verifyDelivery(target, input.message, {
        request: input,
        resolution: reResolution,
        verification: secondVerification,
        sent,
        snapshot: deliverySnapshot,
        phase: currentPhase,
      });
    } catch (error) {
      return fail(currentPhase, 'DELIVERY_UNVERIFIED', publicReason(error, '送达证据读取失败，需对账'), { reconciliationRequired: true });
    }
    if (!okResult(delivery) || delivery.delivered !== true) {
      return fail(currentPhase, isObject(delivery) && delivery.code ? text(delivery.code) : 'DELIVERY_UNVERIFIED', publicReason(delivery, '未找到目标会话的新 user message'), { reconciliationRequired: true });
    }
    record(currentPhase, 'ok', delivery);

    currentPhase = 'COMMIT';
    record(currentPhase, 'ok', { deliveryVerified: true, sendAttempted });
    return createResult(phases, evidence, {
      ok: true,
      status: 'committed',
      phase: currentPhase,
      target,
      reconciliationRequired: false,
    });
  } catch (error) {
    return fail(currentPhase, sendAttempted ? 'DISPATCH_RECONCILIATION_REQUIRED' : 'DISPATCH_FAILED', publicReason(error, 'Verified Dispatch 执行失败'), {
      reconciliationRequired: sendAttempted,
    });
  } finally {
    if (release) release();
  }
}

module.exports = {
  dispatchVerifiedMessage,
  _resetVerifiedDispatchLocksForTests() {
    lockTails.clear();
  },
};
