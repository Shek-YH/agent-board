'use strict';

const { HttpException, HttpStatus } = require('@nestjs/common');

const DEFAULT_LIMITS = Object.freeze({
  login: { max: 10, windowSeconds: 60 },
  register: { max: 5, windowSeconds: 3600 },
  'forgot-password': { max: 5, windowSeconds: 3600 },
  refresh: { max: 20, windowSeconds: 60 },
  acquire: { max: 30, windowSeconds: 60 },
  redeem: { max: 10, windowSeconds: 60 },
  'device-enroll': { max: 5, windowSeconds: 3600 },
  heartbeat: { max: 120, windowSeconds: 60 },
});

function normalizeLimit(value, fallback) {
  const max = Number(value?.max);
  const windowSeconds = Number(value?.windowSeconds);
  if (!Number.isSafeInteger(max) || max < 1 || max > 1000000 || !Number.isSafeInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 86400) {
    return fallback;
  }
  return { max, windowSeconds };
}

function loadLimits(raw = process.env.RATE_LIMITS_JSON) {
  if (!raw || !raw.trim()) return { ...DEFAULT_LIMITS };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const error = new Error('RATE_LIMITS_JSON must be valid JSON');
    error.code = 'INVALID_RATE_LIMIT_CONFIG';
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error('RATE_LIMITS_JSON must be an object');
    error.code = 'INVALID_RATE_LIMIT_CONFIG';
    throw error;
  }
  return Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([route, fallback]) => [route, normalizeLimit(parsed[route], fallback)]));
}

function dimensionKeys({ route, ip, userId, deviceId }) {
  const keys = [`${route}|ip:${ip || 'unknown'}`];
  if (userId) keys.push(`${route}|user:${userId}`);
  if (deviceId) keys.push(`${route}|device:${deviceId}`);
  return keys;
}

class RateLimitService {
  constructor({ limits = DEFAULT_LIMITS, clock = () => Date.now(), onLimited } = {}) {
    this.limits = limits;
    this.clock = clock;
    this.onLimited = onLimited;
    this.buckets = new Map();
  }

  consume(input = {}) {
    const route = String(input.route || '').trim();
    const limit = this.limits[route];
    if (!limit) return { limited: false, remaining: null, resetAt: null };
    const now = this.clock();
    const keys = dimensionKeys({ ...input, route });
    const entries = keys.map((key) => {
      const existing = this.buckets.get(key);
      const bucket = existing && existing.resetAt > now
        ? existing
        : { count: 0, resetAt: now + limit.windowSeconds * 1000 };
      return { key, bucket };
    });
    const blocked = entries.find(({ bucket }) => bucket.count >= limit.max);
    if (blocked) {
      const retryAfterSeconds = Math.max(1, Math.ceil((blocked.bucket.resetAt - now) / 1000));
      this.onLimited?.({
        type: 'RATE_LIMITED',
        severity: 'MEDIUM',
        userId: input.userId,
        deviceId: input.deviceId,
        ip: input.ip,
        metadata: { route, dimension: blocked.key.split('|').at(-1), retryAfterSeconds },
      });
      throw new HttpException({ code: 'RATE_LIMITED', retryAfterSeconds }, HttpStatus.TOO_MANY_REQUESTS);
    }
    for (const { key, bucket } of entries) {
      bucket.count += 1;
      this.buckets.set(key, bucket);
    }
    if (this.buckets.size > 10000) {
      for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    const resetAt = Math.max(...entries.map(({ bucket }) => bucket.resetAt));
    return { limited: false, remaining: Math.max(0, limit.max - entries[0].bucket.count), resetAt };
  }
}

function createRateLimitService(options = {}) {
  return new RateLimitService({ ...options, limits: options.limits || loadLimits(options.raw) });
}

module.exports = { DEFAULT_LIMITS, RateLimitService, createRateLimitService, dimensionKeys, loadLimits };
