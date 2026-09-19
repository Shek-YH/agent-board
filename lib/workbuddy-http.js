'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_HOOK_PATH = '/internal/hooks/workbuddy';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

function nonBlank(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function createHookAuth({ env = process.env, envKey = 'AGENT_BOARD_WORKBUDDY_HTTP_TOKEN', randomBytes = crypto.randomBytes } = {}) {
  const configured = nonBlank(env[envKey]);
  if (configured && configured.length >= 32) return { token: configured, source: 'environment' };
  return { token: randomBytes(32).toString('hex'), source: 'ephemeral' };
}

function isLoopbackAddress(address) {
  const normalized = String(address || '').replace(/^::ffff:/i, '');
  return normalized === '127.0.0.1' || normalized === '::1';
}

function authorizeHookRequest(req, token) {
  if (!isLoopbackAddress(req?.socket?.remoteAddress)) return false;
  if (!/^application\/json(?:\s*;|$)/i.test(String(req?.headers?.['content-type'] || '').trim())) return false;
  const expected = nonBlank(token);
  const authorization = nonBlank(req?.headers?.authorization);
  if (!expected || !authorization || !/^Bearer\s+/i.test(authorization)) return false;
  const provided = authorization.replace(/^Bearer\s+/i, '').trim();
  const expectedBytes = Buffer.from(expected, 'utf8');
  const providedBytes = Buffer.from(provided, 'utf8');
  return expectedBytes.length === providedBytes.length && crypto.timingSafeEqual(expectedBytes, providedBytes);
}

function createHookUrl({ port, path = DEFAULT_HOOK_PATH } = {}) {
  const normalizedPath = `/${String(path || DEFAULT_HOOK_PATH).replace(/^\/+/, '')}`;
  return `http://127.0.0.1:${Number(port) || 0}${normalizedPath}`;
}

function readJsonBody(req, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        const error = new Error('Request body too large');
        error.statusCode = 413;
        try { req.resume(); } catch { /* ignore */ }
        fail(error);
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => {
      if (settled) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks, total).toString('utf8') || '{}');
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid json body');
        settled = true;
        resolve(value);
      } catch {
        fail(new Error('Invalid JSON body'));
      }
    });
    req.on('error', fail);
  });
}

function writeHookConfig(filePath, config, fsApi = fs) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return false;
  if (!config || typeof config.url !== 'string' || typeof config.token !== 'string') return false;
  try {
    fsApi.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fsApi.writeFileSync(filePath, JSON.stringify({ url: config.url, token: config.token }), { mode: 0o600 });
    if (process.platform !== 'win32') {
      try { fsApi.chmodSync(filePath, 0o600); } catch { /* fail-open */ }
    }
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_HOOK_PATH,
  DEFAULT_MAX_BODY_BYTES,
  createHookAuth,
  isLoopbackAddress,
  authorizeHookRequest,
  createHookUrl,
  readJsonBody,
  writeHookConfig,
};
