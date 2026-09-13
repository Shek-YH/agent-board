'use strict';

const crypto = require('node:crypto');

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DEFAULT_UI_BODY_BYTES = 10 * 1024 * 1024;

function isLoopbackAddress(address) {
  const normalized = String(address || '').replace(/^::ffff:/i, '');
  return normalized === '127.0.0.1' || normalized === '::1';
}

function createRuntimeAuth({ randomBytes = crypto.randomBytes } = {}) {
  return { token: randomBytes(32).toString('hex'), source: 'ephemeral' };
}

function sameToken(provided, expected) {
  const actualBytes = Buffer.from(String(provided || ''), 'utf8');
  const expectedBytes = Buffer.from(String(expected || ''), 'utf8');
  return expectedBytes.length > 0
    && actualBytes.length === expectedBytes.length
    && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function allowedHost(value, port) {
  const host = String(value || '').trim().toLowerCase();
  const suffix = `:${Number(port) || 0}`;
  return host === `127.0.0.1${suffix}` || host === `localhost${suffix}` || host === `[::1]${suffix}`;
}

function allowedOrigin(value, port) {
  const origin = String(value || '').trim().toLowerCase();
  if (!origin) return true;
  return origin === `http://127.0.0.1:${Number(port) || 0}`
    || origin === `http://localhost:${Number(port) || 0}`
    || origin === `http://[::1]:${Number(port) || 0}`;
}

function hasBody(req) {
  const length = Number(req?.headers?.['content-length']);
  if (Number.isFinite(length)) return length > 0;
  return Boolean(req?.headers?.['transfer-encoding']);
}

/** @param {any} req @param {{port?: number}} options */
function authorizeUiRequest(req, { port } = {}) {
  return isLoopbackAddress(req?.socket?.remoteAddress)
    && allowedHost(req?.headers?.host, port)
    && allowedOrigin(req?.headers?.origin, port);
}

/** @param {any} req @param {string} token @param {{port?: number}} options */
/** @param {any} req @param {string} token @param {{port?: number, maxBodyBytes?: number}} options */
function authorizeUiMutation(req, token, { port, maxBodyBytes = DEFAULT_UI_BODY_BYTES } = {}) {
  const method = String(req?.method || '').toUpperCase();
  if (!MUTATION_METHODS.has(method)) return false;
  if (!authorizeUiRequest(req, { port })) return false;
  const authorization = String(req?.headers?.authorization || '').trim();
  if (!/^Bearer\s+/i.test(authorization)) return false;
  if (!sameToken(authorization.replace(/^Bearer\s+/i, '').trim(), token)) return false;
  const contentLength = Number(req?.headers?.['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) return false;
  if (method !== 'DELETE' && hasBody(req) && !/^application\/json(?:\s*;|$)/i.test(String(req?.headers?.['content-type'] || '').trim())) return false;
  return true;
}

module.exports = { DEFAULT_UI_BODY_BYTES, MUTATION_METHODS, createRuntimeAuth, authorizeUiRequest, authorizeUiMutation };
