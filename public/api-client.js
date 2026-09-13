'use strict';

(function exposeApiClient(global) {
  const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  let runtimeTokenPromise = null;

  async function getRuntimeToken(fetcher) {
    if (!runtimeTokenPromise) {
      runtimeTokenPromise = fetcher('/api/runtime-auth', { headers: { Accept: 'application/json' } })
        .then(async (response) => {
          const raw = await response.text();
          let data;
          try { data = JSON.parse(raw); } catch { throw new Error('运行时认证响应无效'); }
          if (!response.ok || !data || typeof data.token !== 'string' || !data.token) throw new Error('运行时认证失败');
          return data.token;
        })
        .catch((error) => { runtimeTokenPromise = null; throw error; });
    }
    return runtimeTokenPromise;
  }

  function createApiError(data, status, statusText, fallback) {
    const error = new Error(data?.error || fallback || `HTTP ${status} ${statusText || ''}`.trim());
    if (data && typeof data === 'object') {
      if (data.code) error.code = String(data.code);
      if (data.recovery && typeof data.recovery === 'object') error.recovery = data.recovery;
      for (const field of ['missingFields', 'missingFieldLabels', 'reasons', 'suggestedActions', 'permissionViolations']) {
        if (Array.isArray(data[field])) error[field] = data[field];
      }
    }
    error.status = status;
    return error;
  }

  async function requestJson(url, requestOptions = {}) {
    let { fetchImpl, timeoutMs = 5000, allowFailure = false, ...options } = requestOptions;
    const fetcher = fetchImpl || global.fetch;
    if (typeof fetcher !== 'function') throw new Error('当前环境不支持网络请求');
    const method = String(options.method || 'GET').toUpperCase();
    if (!fetchImpl && MUTATION_METHODS.has(method) && url !== '/api/runtime-auth') {
      const token = await getRuntimeToken(fetcher);
      options = { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } };
    }
    const controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
    let timer = null;
    if (controller && timeoutMs > 0) timer = global.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url, controller ? { ...options, signal: controller.signal } : options);
      const raw = await response.text();
      if (!raw.trim()) throw new Error(`HTTP ${response.status}：服务端没有返回 JSON`);
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`HTTP ${response.status}：服务端返回的不是有效 JSON`);
      }
      if (!response.ok && !allowFailure) throw createApiError(data, response.status, response.statusText, `HTTP ${response.status}`);
      if (data && data.ok === false && !allowFailure) throw createApiError(data, response.status, response.statusText, '服务端操作失败');
      return data;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`请求超时：${url}`);
      throw error;
    } finally {
      if (timer) global.clearTimeout(timer);
    }
  }

  global.AgentBoardApi = { requestJson };
  if (typeof module !== 'undefined' && module.exports) module.exports = { requestJson };
})(typeof window !== 'undefined' ? window : globalThis);
