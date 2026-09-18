'use strict';

const { applyEvent, initialState } = require('./reducer');
const { selectRuntimeSnapshot } = require('./selectors');

// 「进行中/待确认」是活体判定，必须有保鲜期。没有事件驱动的会话不会自己老化，
// 一旦写入 ACTIVE / COMPLETION_CANDIDATE / WAITING_USER 就会永久保留（实测最长 390 小时），
// 前端又把它当作权威 live 来源 → 早已结束的会话永久显示「进行中」。
// 因此 read-time 做一次老化：超过 staleMs 没有新证据的状态一律降级为 IDLE（= 非 live）。
// 与 store.lastMsgAt 的 10 分钟活跃窗口同量级，但留出余量给长工具调用 / 长思考。
const DEFAULT_STALE_MS = 30 * 60 * 1000;
const AGING_STATES = new Set(['ACTIVE', 'COMPLETION_CANDIDATE', 'WAITING_USER']);

function createSessionLifecycleEngine(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const stabilizationMs = Math.max(0, Number(options.stabilizationMs ?? 5000));
  const staleMs = Number.isFinite(Number(options.staleMs)) ? Math.max(0, Number(options.staleMs)) : DEFAULT_STALE_MS;
  let state = initialState(options.initialState);

  function ingest(event) {
    const before = state;
    state = applyEvent(state, event);
    return { changed: state !== before, state: selectRuntimeSnapshot(state) };
  }

  function advance(now = clock()) {
    if (state.publicState !== 'COMPLETION_CANDIDATE' || now < state.completionCandidateAt + stabilizationMs) {
      return { changed: false, state: selectRuntimeSnapshot(state) };
    }
    return ingest({
      schemaVersion: 1,
      eventId: `completion-confirmed:${state.completionCandidateAt}`,
      agent: 'lifecycle',
      sessionRef: 'lifecycle:internal',
      sessionId: 'internal',
      timestamp: now,
      type: 'COMPLETION_CONFIRMED',
      source: 'lifecycle_engine',
    });
  }

  // 读取时老化：不修改内部状态（保留原始证据与时间戳，便于诊断），只影响对外投影。
  // 关键：老化的参考时刻必须取 max(事件时刻, now)。runtime store 是惰性建引擎的，
  // 一个刚写完事件、此前从未被投影过的会话，其引擎创建时刻（真实 Date.now()）会远晚于
  // 事件时刻，若直接用 now 判定就会把「刚刚发生」误判成陈旧。
  function aged(now) {
    if (!AGING_STATES.has(state.publicState)) return state;
    const reference = Math.max(Number(now) || 0, state.updatedAt);
    if (reference - state.updatedAt < staleMs) return state;
    return { ...state, publicState: 'IDLE', stale: true };
  }

  return {
    ingest,
    advance,
    getState: (now = clock()) => selectRuntimeSnapshot(aged(now)),
    getInternalState: () => initialState(state),
  };
}

module.exports = { createSessionLifecycleEngine };
