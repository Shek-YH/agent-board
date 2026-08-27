'use strict';

(function exposeApiClient(global) {
  async function requestJson(url, requestOptions = {}) {
    const { fetchImpl, timeoutMs = 12000, allowFailure = false, ...options } = requestOptions;
    const fetcher = fetchImpl || global.fetch;
    if (typeof fetcher !== 'function') throw new Error('当前环境不支持网络请求');
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
      if (!response.ok && !allowFailure) throw new Error(data?.error || `HTTP ${response.status} ${response.statusText || ''}`.trim());
      if (data && data.ok === false && !allowFailure) throw new Error(data.error || '服务端操作失败');
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
