'use strict';

const { CANONICAL_DIMENSIONS } = require('../enums');

const DEFAULT_SOURCE_AUTHORITY_POLICY = Object.freeze({
  fullLifecycleAuthority: false,
  authority: Object.freeze({
    [CANONICAL_DIMENSIONS.LIVENESS]: Object.freeze({ process: 70, app_server: 80, heartbeat: 75, terminal: 50, pty: 40, ui: 30, legacy_fallback: 20 }),
    [CANONICAL_DIMENSIONS.TURN]: Object.freeze({ native_hook: 100, jsonl: 90, app_server: 80, database: 85, pty: 40, legacy_fallback: 20 }),
    [CANONICAL_DIMENSIONS.ACTIVITY]: Object.freeze({ native_hook: 100, jsonl: 90, app_server: 80, pty: 40, ui: 30, legacy_fallback: 20 }),
    [CANONICAL_DIMENSIONS.SESSION_LIFECYCLE]: Object.freeze({ native_hook: 100, database: 85, app_server: 80, process: 70, terminal: 50, legacy_fallback: 10 }),
    [CANONICAL_DIMENSIONS.ATTENTION]: Object.freeze({ native_hook: 100, manual: 100, jsonl: 90, database: 85, ui: 30, legacy_fallback: 20 }),
  }),
  ttlMs: Object.freeze({ process: 6000, heartbeat: 45000, ui: 2000, pty: 2000 }),
});

module.exports = { DEFAULT_SOURCE_AUTHORITY_POLICY };
