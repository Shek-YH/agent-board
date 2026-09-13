'use strict';

const { DEFAULT_SOURCE_AUTHORITY_POLICY } = require('./default');

const WORKBUDDY_SOURCE_AUTHORITY_POLICY = Object.freeze({
  ...DEFAULT_SOURCE_AUTHORITY_POLICY,
  fullLifecycleAuthority: true,
});

module.exports = { WORKBUDDY_SOURCE_AUTHORITY_POLICY };
