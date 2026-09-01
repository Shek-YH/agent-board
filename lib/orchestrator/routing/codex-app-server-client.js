'use strict';

const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildInvocation(executablePath) {
  const executable = text(executablePath) || 'codex';
  if (process.platform === 'win32' && path.extname(executable).toLowerCase() === '.cmd') {
    return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'call', executable, 'app-server', '--stdio'] };
  }
  return { command: executable, args: ['app-server', '--stdio'] };
}

function killProcessTreeByPid(pid, execFileImpl = execFile) {
  return new Promise((resolve, reject) => {
    execFileImpl('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

class CodexAppServerClient {
  constructor({ executablePath = 'codex', spawnImpl = spawn, execFileImpl = execFile, platform = process.platform, clientName = 'agent-board', clientVersion = '0.1.0', timeoutMs = 15_000 } = {}) {
    this.executablePath = executablePath;
    this.spawnImpl = spawnImpl;
    this.execFileImpl = execFileImpl;
    this.platform = platform;
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.buffer = '';
    this.nextRequestId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.notificationWaiters = new Set();
    this.startPromise = null;
  }

  async request(method, params = {}) {
    await this.ensureStarted();
    return this.sendRequest(method, params);
  }

  async ensureStarted() {
    if (this.child && !this.child.killed) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async start() {
    const invocation = buildInvocation(this.executablePath);
    let child;
    try {
      child = this.spawnImpl(invocation.command, invocation.args, {
        cwd: process.cwd(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      const wrapped = new Error(`unable to start codex app server: ${error.message}`);
      wrapped.code = 'APP_SERVER_START_FAILED';
      throw wrapped;
    }
    this.child = child;
    this.buffer = '';
    child.stdout?.on('data', (chunk) => this.consume(chunk));
    child.stderr?.on('data', () => {});
    child.once('error', (error) => {
      this.failPending(error);
      this.failNotificationWaiters(error);
    });
    child.once('exit', () => {
      this.child = null;
      const error = new Error('app server process is not running');
      this.failPending(error);
      this.failNotificationWaiters(error);
    });
    await this.sendRequest('initialize', {
      clientInfo: { name: this.clientName, version: this.clientVersion },
      capabilities: { experimentalApi: true },
    });
    this.sendNotification('initialized', {});
  }

  sendRequest(method, params) {
    if (!this.child || !this.child.stdin || typeof this.child.stdin.write !== 'function') {
      return Promise.reject(new Error('app server process is not running'));
    }
    const id = this.nextRequestId++;
    const message = { method, id, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`codex app server request timed out: ${method}`);
        error.code = 'APP_SERVER_TIMEOUT';
        reject(error);
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try { this.child.stdin.write(`${JSON.stringify(message)}\n`); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  sendNotification(method, params) {
    if (!this.child || !this.child.stdin || typeof this.child.stdin.write !== 'function') return;
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  waitForNotification({ method, predicate = () => true, timeoutMs = this.timeoutMs } = {}) {
    const queuedIndex = this.notifications.findIndex((event) => event.method === method && predicate(event));
    if (queuedIndex >= 0) return Promise.resolve(this.notifications.splice(queuedIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { method, predicate, resolve, reject, timer: null };
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this.notificationWaiters.delete(waiter);
          const error = new Error(`codex app server notification timed out: ${method}`);
          error.code = 'APP_SERVER_NOTIFICATION_TIMEOUT';
          reject(error);
        }, timeoutMs);
        waiter.timer.unref?.();
      }
      this.notificationWaiters.add(waiter);
    });
  }

  consume(chunk) {
    this.buffer += chunk.toString();
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { this.handleMessage(JSON.parse(line)); } catch { /* malformed protocol output is ignored */ }
    }
  }

  handleMessage(message) {
    if (message && Object.prototype.hasOwnProperty.call(message, 'id')) {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) {
        const error = new Error(message.error.message || 'codex app server request failed');
        error.code = message.error.code || 'APP_SERVER_REQUEST_FAILED';
        request.reject(error);
      } else request.resolve(message.result);
      return;
    }
    if (!message || !message.method) return;
    for (const waiter of this.notificationWaiters) {
      if (waiter.method !== message.method) continue;
      let matches = false;
      try { matches = waiter.predicate(message) === true; } catch { matches = false; }
      if (!matches) continue;
      this.notificationWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    this.notifications.push(message);
    if (this.notifications.length > 100) this.notifications.shift();
  }

  failPending(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  failNotificationWaiters(error) {
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.notificationWaiters.clear();
  }

  async close() {
    this.failNotificationWaiters(new Error('app server client closed'));
    this.failPending(new Error('app server client closed'));
    const child = this.child;
    this.child = null;
    if (!child || typeof child.kill !== 'function') return;
    if (typeof child.once !== 'function') {
      child.kill();
      return;
    }
    await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      child.once('exit', finish);
      child.once('close', finish);
      timer = setTimeout(finish, 2_000);
      timer.unref?.();
      if (this.platform === 'win32' && child.pid) {
        killProcessTreeByPid(child.pid, this.execFileImpl).catch(() => {
          try { child.kill(); } catch { finish(); }
        });
      } else {
        try { child.kill(); } catch { finish(); }
      }
    });
  }
}

function createCodexAppServerClient(options) {
  return new CodexAppServerClient(options);
}

module.exports = { CodexAppServerClient, buildInvocation, createCodexAppServerClient };
