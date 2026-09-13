'use strict';

const { DEFAULT_SOURCE_AUTHORITY_POLICY } = require('./default');

const CODEX_SOURCE_AUTHORITY_POLICY = Object.freeze({
  ...DEFAULT_SOURCE_AUTHORITY_POLICY,
  fullLifecycleAuthority: false,
});

module.exports = { CODEX_SOURCE_AUTHORITY_POLICY };
