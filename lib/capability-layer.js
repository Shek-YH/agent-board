'use strict';

const CAPABILITY_NAMES = Object.freeze([
  'sessionLocator',
  'sessionActivator',
  'conversationReader',
  'identityVerifier',
  'messageWriter',
  'deliveryVerifier',
  'completionDetector',
]);

const CAPABILITY_NAME_SET = new Set(CAPABILITY_NAMES);

function typeError(message) {
  return new TypeError('Invalid capability contract: ' + message);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isImplementation(value) {
  return typeof value === 'function'
    || (value !== null && typeof value === 'object' && !Array.isArray(value));
}

function normalizeMethods(value, name) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => !text(item))) {
    throw typeError(name + '.methods must be an array of non-empty strings');
  }
  return Object.freeze([...new Set(value.map(text))]);
}

function createCapabilitySet(agentId, definitions) {
  const id = text(agentId);
  if (!id) throw typeError('agentId must be a non-empty string');
  if (definitions === null || typeof definitions !== 'object' || Array.isArray(definitions)) {
    throw typeError(id + ' capabilities must be an object');
  }

  const names = Object.keys(definitions);
  if (names.length !== CAPABILITY_NAMES.length || names.some((name) => !CAPABILITY_NAME_SET.has(name))) {
    throw typeError(id + ' must declare exactly the known capabilities');
  }

  const normalized = {};
  for (const name of CAPABILITY_NAMES) {
    const definition = definitions[name];
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      throw typeError(id + '.' + name + ' must be an object');
    }
    if (typeof definition.supported !== 'boolean') {
      throw typeError(id + '.' + name + '.supported must be boolean');
    }
    const source = text(definition.source);
    if (!source) throw typeError(id + '.' + name + '.source must be non-empty');
    const methods = normalizeMethods(definition.methods, id + '.' + name);

    if (definition.supported) {
      if (!isImplementation(definition.implementation)) {
        throw typeError(id + '.' + name + '.implementation is required when supported');
      }
      normalized[name] = Object.freeze({
        name,
        supported: true,
        implementation: definition.implementation,
        source,
        ...(methods ? { methods } : {}),
      });
      continue;
    }

    if (definition.implementation !== null) {
      throw typeError(id + '.' + name + '.implementation must be null when unsupported');
    }
    const reason = text(definition.reason);
    if (!reason) throw typeError(id + '.' + name + '.reason is required when unsupported');
    normalized[name] = Object.freeze({
      name,
      supported: false,
      implementation: null,
      source,
      reason,
      ...(methods ? { methods } : {}),
    });
  }

  const capabilities = Object.freeze(normalized);
  const set = {
    agentId: id,
    capabilities,
    has(name) {
      return CAPABILITY_NAME_SET.has(name) && capabilities[name] !== undefined;
    },
    get(name) {
      return set.has(name) ? capabilities[name] : null;
    },
    report() {
      return {
        agentId: id,
        capabilities: Object.fromEntries(CAPABILITY_NAMES.map((name) => {
          const capability = capabilities[name];
          return [name, {
            supported: capability.supported,
            source: capability.source,
            ...(capability.reason ? { reason: capability.reason } : {}),
          }];
        })),
      };
    },
  };
  return Object.freeze(set);
}

function createCapabilityRegistry(definitions) {
  if (!Array.isArray(definitions)) throw typeError('registry definitions must be an array');
  const sets = new Map();
  for (const definition of definitions) {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      throw typeError('registry definition must be an object');
    }
    const set = createCapabilitySet(definition.agentId, definition.capabilities);
    if (sets.has(set.agentId)) throw typeError('duplicate agentId: ' + set.agentId);
    sets.set(set.agentId, set);
  }
  return Object.freeze({
    has(agentId) {
      return sets.has(text(agentId));
    },
    get(agentId) {
      return sets.get(text(agentId)) || null;
    },
    list() {
      return [...sets.values()];
    },
    report() {
      return [...sets.values()].map((set) => set.report());
    },
  });
}

module.exports = {
  CAPABILITY_NAMES,
  createCapabilitySet,
  createCapabilityRegistry,
};
