'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOT_WINDOW_MS = DAY_MS;
const WARM_WINDOW_MS = 7 * DAY_MS;
const RECENT_WINDOW_MS = 30 * DAY_MS;
const WARM_RECONCILE_INTERVAL_MS = 60 * 60 * 1000;
const FULL_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_FULL_GRACE_MS = 60 * 1000;

const REQUESTS = Object.freeze({
  'startup-recent': Object.freeze({ kind: 'startup-recent', full: false, maxAgeMs: HOT_WINDOW_MS, priority: 30 }),
  'warm-reconcile': Object.freeze({ kind: 'warm-reconcile', full: false, maxAgeMs: WARM_WINDOW_MS, priority: 20 }),
  'scheduled-full': Object.freeze({ kind: 'scheduled-full', full: true, maxAgeMs: 0, priority: 40 }),
  'manual-full': Object.freeze({ kind: 'manual-full', full: true, maxAgeMs: 0, priority: 50 }),
});

function classifyActivity({ lastSeen = 0, fileMtime = 0, known = true, now = Date.now() } = {}) {
  if (!known) return 'hot';
  const activityAt = Math.max(Number(lastSeen) || 0, Number(fileMtime) || 0);
  if (!activityAt) return 'cold';
  const age = Math.max(0, now - activityAt);
  if (age <= HOT_WINDOW_MS) return 'hot';
  if (age <= WARM_WINDOW_MS) return 'warm';
  if (age <= RECENT_WINDOW_MS) return 'recent';
  return 'cold';
}

function isFullScanDue(lastFullScanAt, now = Date.now(), intervalMs = FULL_SCAN_INTERVAL_MS) {
  const last = Number(lastFullScanAt) || 0;
  return !last || now - last >= intervalMs;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createScanScheduler({
  run,
  readLastFullScanAt = () => 0,
  writeLastFullScanAt = () => {},
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  warmIntervalMs = WARM_RECONCILE_INTERVAL_MS,
  fullIntervalMs = FULL_SCAN_INTERVAL_MS,
  startupFullGraceMs = STARTUP_FULL_GRACE_MS,
  onStateChange = () => {},
} = {}) {
  if (typeof run !== 'function') throw new TypeError('scan scheduler requires a run function');

  let started = false;
  let stopped = false;
  let active = null;
  let pending = [];
  let warmTimer = null;
  let fullTimer = null;
  let fullRetryAt = 0;
  let lastError = null;
  const idleWaiters = new Set();

  function state() {
    const lastFullScanAt = Number(readLastFullScanAt()) || 0;
    return {
      scanning: Boolean(active),
      activeKind: active ? active.request.kind : null,
      pendingKinds: pending.map((entry) => entry.request.kind),
      lastFullScanAt,
      nextFullScanAt: fullTimer && fullTimer.dueAt ? fullTimer.dueAt : (lastFullScanAt ? lastFullScanAt + fullIntervalMs : null),
      lastError: lastError ? String(lastError.message || lastError) : null,
    };
  }

  function notify() {
    try { onStateChange(state()); } catch { /* 诊断回调不能阻断扫描 */ }
  }

  function resolveIdle() {
    if (active || pending.length) return;
    for (const waiter of idleWaiters) waiter.resolve();
    idleWaiters.clear();
  }

  function requestDefinition(kind) {
    const request = REQUESTS[kind];
    if (!request) throw new Error(`未知扫描类型: ${kind}`);
    return request;
  }

  function findMergeable(request) {
    return pending.find((entry) => entry.request.kind === request.kind || (entry.request.full && request.full));
  }

  function scheduleWarm() {
    if (stopped || !started) return;
    if (warmTimer) clearTimeoutFn(warmTimer.handle);
    const dueAt = now() + warmIntervalMs;
    const handle = setTimeoutFn(() => {
      warmTimer = null;
      request('warm-reconcile').catch(() => {}).finally(scheduleWarm);
    }, warmIntervalMs);
    warmTimer = { handle, dueAt };
  }

  function scheduleFull() {
    if (stopped || !started) return;
    if (fullTimer) clearTimeoutFn(fullTimer.handle);
    const current = now();
    const last = Number(readLastFullScanAt()) || 0;
    const dueAt = Math.max(
      current + (isFullScanDue(last, current, fullIntervalMs) ? startupFullGraceMs : Math.max(0, last + fullIntervalMs - current)),
      fullRetryAt || 0,
    );
    const delay = Math.max(0, dueAt - current);
    const handle = setTimeoutFn(() => {
      fullTimer = null;
      if (!isFullScanDue(readLastFullScanAt(), now(), fullIntervalMs) && !fullRetryAt) {
        scheduleFull();
        return;
      }
      request('scheduled-full').catch(() => {}).finally(scheduleFull);
    }, delay);
    fullTimer = { handle, dueAt };
    notify();
  }

  function startNext() {
    if (stopped || active || !pending.length) {
      resolveIdle();
      return;
    }
    pending.sort((left, right) => right.request.priority - left.request.priority);
    const entry = pending.shift();
    const runResult = deferred();
    active = { request: entry.request, promise: runResult.promise };
    runResult.promise.catch(() => {});
    notify();

    let result;
    try { result = run({ ...entry.request }); }
    catch (error) { result = Promise.reject(error); }

    Promise.resolve(result).then((value) => {
      lastError = null;
      if (entry.request.full) {
        try {
          writeLastFullScanAt(now());
          fullRetryAt = 0;
        } catch (error) {
          lastError = error;
          fullRetryAt = now() + fullIntervalMs;
        }
      }
      runResult.resolve(value);
      for (const waiter of entry.waiters) waiter.resolve(value);
    }, (error) => {
      lastError = error;
      if (entry.request.full) fullRetryAt = now() + fullIntervalMs;
      runResult.reject(error);
      for (const waiter of entry.waiters) waiter.reject(error);
    }).finally(() => {
      active = null;
      notify();
      if (entry.request.full) scheduleFull();
      startNext();
    });
  }

  function request(kind) {
    if (stopped) return Promise.reject(new Error('scan scheduler is stopped'));
    const requestValue = requestDefinition(kind);
    if (kind === 'scheduled-full' && !isFullScanDue(readLastFullScanAt(), now(), fullIntervalMs)) {
      return Promise.resolve(null);
    }
    if (active && active.request.full && requestValue.full) return active.promise;

    const entry = findMergeable(requestValue);
    const waiter = deferred();
    if (entry) {
      if (requestValue.priority > entry.request.priority) entry.request = requestValue;
      entry.waiters.push(waiter);
    } else {
      pending.push({ request: requestValue, waiters: [waiter] });
    }
    notify();
    startNext();
    return waiter.promise;
  }

  function start() {
    if (stopped) return state();
    if (started) return state();
    started = true;
    scheduleWarm();
    scheduleFull();
    notify();
    return state();
  }

  function whenIdle() {
    if (!active && !pending.length) return Promise.resolve();
    const waiter = deferred();
    idleWaiters.add(waiter);
    return waiter.promise;
  }

  function stop() {
    stopped = true;
    if (warmTimer) clearTimeoutFn(warmTimer.handle);
    if (fullTimer) clearTimeoutFn(fullTimer.handle);
    warmTimer = null;
    fullTimer = null;
    notify();
  }

  return { start, request, getState: state, whenIdle, stop };
}

module.exports = {
  DAY_MS,
  HOT_WINDOW_MS,
  WARM_WINDOW_MS,
  RECENT_WINDOW_MS,
  WARM_RECONCILE_INTERVAL_MS,
  FULL_SCAN_INTERVAL_MS,
  STARTUP_FULL_GRACE_MS,
  classifyActivity,
  isFullScanDue,
  createScanScheduler,
};
