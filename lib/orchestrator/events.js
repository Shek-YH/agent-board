'use strict';

const { EventEmitter } = require('node:events');

class OrchestrationEvents extends EventEmitter {
  constructor() {
    super();
    this.seenSources = new Set();
  }

  emitSessionMessage(message) {
    const key = `${message.agent || ''}:${message.sourceId || ''}`;
    if (!message.sourceId || this.seenSources.has(key)) return false;
    this.seenSources.add(key);
    this.emit('session_message', { ...message, origin: 'agent-board' });
    return true;
  }
}

module.exports = { OrchestrationEvents };
