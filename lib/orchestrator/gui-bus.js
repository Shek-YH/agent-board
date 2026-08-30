'use strict';

class GuiBus {
  constructor() {
    this.tails = new Map();
  }

  run({ agent, sessionRef } = {}, operation) {
    if (typeof operation !== 'function') return Promise.reject(new TypeError('GUI operation is required'));
    const key = `agent:${String(agent || '').trim()}:session:${String(sessionRef || '').trim()}`;
    if (key === 'agent::session:') return Promise.reject(new TypeError('agent and sessionRef are required'));
    const previous = this.tails.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.tails.set(key, current);
    const cleanup = () => { if (this.tails.get(key) === current) this.tails.delete(key); };
    current.then(cleanup, cleanup);
    return current;
  }

  clear() { this.tails.clear(); }
}

module.exports = { GuiBus };
