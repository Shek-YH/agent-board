'use strict';

const { createSessionLifecycleEngine } = require('./engine');

// 稳定的 sessionRef：引擎内部会派生一个 `lifecycle:internal` 事件用于自我确认，
// 若 sessionRef 缺失会让 normalizeEvent 抛错。这里兜底派生，保证任何调用方都不会炸。
function normalizeRef(sessionRef) {
  const ref = String(sessionRef == null ? '' : sessionRef).trim();
  if (ref) return ref;
  return 'session:unknown';
}

function createRuntimeStore(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const engines = new Map();
  function get(sessionRef) {
    const key = normalizeRef(sessionRef);
    if (!engines.has(key)) engines.set(key, createSessionLifecycleEngine(options));
    return engines.get(key);
  }
  // 读取时推进：COMPLETION_CANDIDATE 只有在 advance() 后才会稳定成 COMPLETED。
  // 旧实现从不调用 advance()，于是候选态唯一出口只剩 staleMs 老化 → 被降级成 IDLE（丢失终态语义）。
  // 在投影路径上顺带推进一次，让候选态按其自身稳定窗自然收敛为终态，无需额外定时器。
  // 注意：advance() 本身不会让任何状态「变活」，它只可能把候选态推进到终态，
  // 因此不会破坏 profileLoaded 之外的 fast path。
  return {
    get,
    clear() { engines.clear(); },
    ingest(sessionRef, event) { return get(sessionRef).ingest(event); },
    snapshot(sessionRef, now = clock()) {
      const engine = get(sessionRef);
      engine.advance(now);
      return engine.getState(now);
    },
    entries(now = clock()) {
      return [...engines.entries()].map(([sessionRef, engine]) => {
        engine.advance(now);
        return [sessionRef, engine.getState(now)];
      });
    },
  };
}

module.exports = { createRuntimeStore };
