'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { verifyOfflineGrant } = require('../lib/offline-grant');

class CloudLicenseError extends Error {
  constructor(code, message, statusCode = 0) {
    super(message);
    this.name = 'CloudLicenseError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function nonBlank(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function jsonHeaders() {
  return { accept: 'application/json', 'content-type': 'application/json' };
}

function responseHeader(response, name) {
  return response?.headers?.get?.(name) || response?.headers?.[name] || null;
}

function responseErrorCode(payload, statusCode) {
  return nonBlank(payload?.code)
    || nonBlank(payload?.error?.code)
    || (statusCode === 401 ? 'AUTH_UNAUTHORIZED' : 'CLOUD_REQUEST_FAILED');
}

function responseMessage(payload, fallback) {
  return nonBlank(payload?.message)
    || nonBlank(payload?.error?.message)
    || fallback;
}

function extractSession(result, action) {
  const payload = result?.payload || {};
  const nested = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const accessToken = nonBlank(result?.authToken)
    || nonBlank(payload.accessToken)
    || nonBlank(nested.accessToken)
    || nonBlank(payload.token)
    || nonBlank(nested.token);
  if (!accessToken) throw new CloudLicenseError('AUTH_TOKEN_MISSING', `Cloud ${action} did not return a session token`);
  return {
    accessToken,
    refreshToken: nonBlank(payload.refreshToken) || nonBlank(nested.refreshToken),
    accessTokenExpiresAt: nonBlank(payload.accessTokenExpiresAt) || nonBlank(nested.accessTokenExpiresAt),
    refreshTokenExpiresAt: nonBlank(payload.refreshTokenExpiresAt) || nonBlank(nested.refreshTokenExpiresAt),
    user: payload.user || nested.user || null,
  };
}

function createDeviceIdentity() {
  const keys = crypto.generateKeyPairSync('ed25519');
  return {
    installationId: randomUUID(),
    publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

function privateKeyObject(encoded) {
  return crypto.createPrivateKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'pkcs8' });
}

class CloudLicenseClient {
  constructor({ baseUrl, secureStore, productId = 'agent-board', appVersion = '0.0.0', licensePublicKey = null, fetchImpl = globalThis.fetch, requestTimeoutMs = 12000 } = {}) {
    const normalizedBaseUrl = nonBlank(baseUrl);
    if (!normalizedBaseUrl) throw new CloudLicenseError('INVALID_CLOUD_CONFIG', 'Cloud API URL is required');
    try {
      const parsed = new URL(normalizedBaseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error();
      this.baseUrl = parsed.toString().replace(/\/$/, '');
    } catch {
      throw new CloudLicenseError('INVALID_CLOUD_CONFIG', 'Cloud API URL is invalid');
    }
    if (!secureStore || typeof secureStore.read !== 'function' || typeof secureStore.write !== 'function' || typeof secureStore.clear !== 'function') {
      throw new CloudLicenseError('SECURE_STORAGE_UNAVAILABLE', 'Cloud credentials storage is unavailable');
    }
    if (typeof fetchImpl !== 'function') throw new CloudLicenseError('CLOUD_NETWORK_UNAVAILABLE', 'Fetch is unavailable');
    this.secureStore = secureStore;
    this.productId = nonBlank(productId) || 'agent-board';
    this.appVersion = nonBlank(appVersion) || '0.0.0';
    this.licensePublicKey = nonBlank(licensePublicKey);
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : 12000;
    this.heartbeatTimer = null;
    this.instanceId = randomUUID();
  }

  readState() {
    return this.secureStore.read() || {};
  }

  writeState(next) {
    this.secureStore.write(next);
    return next;
  }

  async request(route, { method = 'GET', body, token, query } = {}) {
    const url = new URL(route.replace(/^\//, ''), `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const headers = jsonHeaders();
    if (token) headers.authorization = `Bearer ${token}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      let response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        throw new CloudLicenseError('CLOUD_NETWORK_UNAVAILABLE', 'Unable to connect to cloud service', 0, { cause: error });
      }
      const text = await response.text();
      let payload = null;
      if (text) {
        try { payload = JSON.parse(text); } catch { payload = { message: text }; }
      }
      if (!response.ok) {
        throw new CloudLicenseError(
          responseErrorCode(payload, response.status),
          responseMessage(payload, `Cloud request failed (${response.status})`),
          response.status,
        );
      }
      return { payload: payload || {}, authToken: responseHeader(response, 'set-auth-token') };
    } finally {
      clearTimeout(timer);
    }
  }

  async login(email, password) {
    const result = await this.request('/v1/desktop/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    return this.persistSession(result, 'login', true);
  }

  async register(email, password, activationCode) {
    const result = await this.request('/v1/registration/register', {
      method: 'POST',
      body: { email, password, activationCode, productId: this.productId },
    });
    return this.persistSession(result, 'registration', true);
  }

  async refresh() {
    const state = this.readState();
    const refreshToken = nonBlank(state.refreshToken);
    if (!refreshToken) throw new CloudLicenseError('AUTH_REFRESH_INVALID', 'Cloud refresh token is missing');
    const result = await this.request('/v1/desktop/auth/refresh', {
      method: 'POST',
      body: { refreshToken },
    });
    return this.persistSession(result, 'refresh', false);
  }

  persistSession(result, action, resetLease) {
    const session = extractSession(result, action);
    const current = this.readState();
    const next = {
      ...current,
      token: session.accessToken,
      accessToken: session.accessToken,
      account: session.user || current.account || null,
    };
    if (session.refreshToken) next.refreshToken = session.refreshToken;
    if (session.accessTokenExpiresAt) next.accessTokenExpiresAt = session.accessTokenExpiresAt;
    if (session.refreshTokenExpiresAt) next.refreshTokenExpiresAt = session.refreshTokenExpiresAt;
    if (resetLease) {
      next.lease = null;
      next.sequence = 0;
    }
    this.writeState(next);
    return { user: next.account };
  }

  async requestPasswordReset(email) {
    await this.request('/v1/auth/request-password-reset', {
      method: 'POST',
      body: { email },
    });
    return { ok: true };
  }

  async logout() {
    const state = this.readState();
    this.stopHeartbeat();
    try {
      const token = nonBlank(state.token) || nonBlank(state.accessToken);
      if (token) await this.request('/v1/desktop/auth/logout', { method: 'POST', token });
    } finally {
      this.secureStore.clear();
    }
    return { state: 'signed_out', configured: true, authenticated: false, features: [] };
  }

  async redeem(code) {
    const state = this.requireToken();
    return (await this.request('/v1/redemptions/redeem', {
      method: 'POST',
      token: state.token,
      body: { code, productId: this.productId },
    })).payload;
  }

  requireToken() {
    const state = this.readState();
    const token = nonBlank(state.token) || nonBlank(state.accessToken);
    if (!token) throw new CloudLicenseError('AUTH_REQUIRED', 'Please sign in first');
    return { ...state, token };
  }

  async ensureDevice() {
    const state = this.requireToken();
    let identity = state.device;
    if (!identity?.installationId || !identity.publicKey || !identity.privateKey) identity = createDeviceIdentity();
    const result = await this.request('/v1/devices/enroll', {
      method: 'POST',
      token: state.token,
      body: {
        installationId: identity.installationId,
        publicKey: identity.publicKey,
        productId: this.productId,
        deviceName: `${os.hostname()} Agent Board`,
        os: process.platform,
        osVersion: os.release(),
        appVersion: this.appVersion,
      },
    });
    const device = result.payload.device || result.payload;
    identity = { ...identity, deviceId: device.id || identity.deviceId };
    this.writeState({ ...this.readState(), device: identity });
    return { state: this.readState(), identity };
  }

  signedRequest(identity, extra = {}) {
    const payload = {
      deviceId: identity.deviceId,
      instanceId: this.instanceId,
      sessionId: this.instanceId,
      timestamp: new Date().toISOString(),
      nonce: randomUUID(),
      appVersion: this.appVersion,
      productId: this.productId,
      ...extra,
    };
    const signature = crypto.sign(
      null,
      Buffer.from(JSON.stringify(canonicalize(payload)), 'utf8'),
      privateKeyObject(identity.privateKey),
    ).toString('base64');
    return { ...payload, signature };
  }

  async acquire() {
    const { state, identity } = await this.ensureDevice();
    const result = await this.request('/v1/license/acquire', {
      method: 'POST',
      token: state.token,
      body: this.signedRequest(identity),
    });
    const next = { ...this.readState(), lease: result.payload.lease || null, sequence: 0 };
    this.writeState(next);
    return result.payload;
  }

  startHeartbeat(lease, { intervalMs = 60000, onError } = {}) {
    this.stopHeartbeat();
    if (!lease?.id) return;
    const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 60000;
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat().catch((error) => onError?.(error));
    }, interval);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async sendHeartbeat() {
    const { state, identity } = await this.ensureDevice();
    const lease = state.lease;
    if (!lease?.id) return null;
    const sequence = Number(state.sequence || 0) + 1;
    const result = await this.request('/v1/license/heartbeat', {
      method: 'POST',
      token: state.token,
      body: this.signedRequest(identity, { leaseId: lease.id, sequence }),
    });
    this.writeState({ ...this.readState(), lease: result.payload.lease || lease, sequence });
    return result.payload;
  }

  async releaseActiveLease() {
    const state = this.readState();
    this.stopHeartbeat();
    if (!state.token || !state.lease?.id) return null;
    try {
      return (await this.request('/v1/license/release', {
        method: 'POST',
        token: state.token,
        body: { leaseId: state.lease.id },
      })).payload;
    } finally {
      this.writeState({ ...this.readState(), lease: null, sequence: 0 });
    }
  }

  offlineStatus(state) {
    if (!this.licensePublicKey || !state.offlineGrant) return null;
    const verified = verifyOfflineGrant(state.offlineGrant, { publicKey: this.licensePublicKey }, { state: state.offlineState || {} });
    if (!verified) return null;
    this.writeState({ ...state, offlineState: verified.nextState });
    return {
      state: 'offline',
      configured: true,
      authenticated: true,
      account: state.account || null,
      features: verified.grant.features,
      validUntil: verified.validUntil * 1000,
    };
  }

  async getStatus({ allowRefresh = true } = {}) {
    const state = this.readState();
    const token = nonBlank(state.token) || nonBlank(state.accessToken);
    if (!token) return { state: 'signed_out', configured: true, authenticated: false, hasCachedToken: false, features: [] };
    try {
      const result = await this.request('/v1/license/status', {
        token,
        query: { productId: this.productId, deviceId: state.device?.deviceId, appVersion: this.appVersion },
      });
      const payload = result.payload;
      const active = Boolean(payload.entitlement);
      if (!active) return { state: 'free', configured: true, authenticated: true, account: payload.user || state.account || null, features: payload.features || {} };
      return {
        state: 'active',
        configured: true,
        authenticated: true,
        account: payload.user || state.account || null,
        entitlement: payload.entitlement,
        limits: payload.limits || {},
        features: payload.features || {},
        device: payload.device || null,
        lease: payload.lease || state.lease || null,
        clientVersionPolicy: payload.clientVersionPolicy || null,
      };
    } catch (error) {
      if (allowRefresh && (error.code === 'AUTH_UNAUTHORIZED' || error.statusCode === 401) && nonBlank(state.refreshToken)) {
        try {
          await this.refresh();
          return this.getStatus({ allowRefresh: false });
        } catch {
          // Fall through to the normal signed-out response below.
        }
      }
      if (error.code === 'AUTH_UNAUTHORIZED' || error.statusCode === 401) {
        this.secureStore.clear();
        return { state: 'signed_out', configured: true, authenticated: false, hasCachedToken: false, features: [], errorCode: error.code };
      }
      const offline = this.offlineStatus(state);
      if (offline) return offline;
      return { state: 'unavailable', configured: true, authenticated: true, hasCachedToken: true, features: [], errorCode: error.code || 'CLOUD_STATUS_FAILED' };
    }
  }
}

module.exports = { CloudLicenseClient, CloudLicenseError };
