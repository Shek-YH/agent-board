'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { apiRequest } from '../../../lib/api';

function formatDate(value) {
  return value ? new Date(value).toLocaleString('zh-CN') : '—';
}

export default function SecurityEventsPage() {
  const router = useRouter();
  const [events, setEvents] = useState({ items: [], meta: null });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEvents(await apiRequest('/v1/admin/security-events'));
      setError('');
    } catch (requestError) {
      if (requestError.status === 401 || requestError.status === 403) return router.replace('/login');
      setError(requestError.code || requestError.message || '安全事件加载失败');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => { load(); }, [load]);

  async function resolve(event) {
    try {
      await apiRequest(`/v1/admin/security-events/${event.id}/resolve`, { method: 'POST' });
      await load();
    } catch (requestError) {
      setError(requestError.code || requestError.message || '安全事件处置失败');
    }
  }

  return <section>
    <div className="page-heading"><div><span className="eyebrow">SECURITY CENTER</span><h1>安全事件</h1><p className="muted">签名失败、重放、限流和并发异常会进入这里；元数据已过滤敏感字段。</p></div><button className="secondary-button" onClick={load} type="button">刷新</button></div>
    {error && <p className="error-message" role="alert">{error}</p>}
    <div className="table-card"><table><thead><tr><th>时间</th><th>类型</th><th>等级</th><th>用户/设备</th><th>来源 IP</th><th>状态</th><th>操作</th></tr></thead><tbody>
      {loading && <tr><td colSpan="7" className="empty-state">加载中…</td></tr>}
      {!loading && events.items.length === 0 && <tr><td colSpan="7" className="empty-state">暂无安全事件</td></tr>}
      {!loading && events.items.map((event) => <tr key={event.id}><td>{formatDate(event.createdAt)}</td><td><strong>{event.type}</strong><small>{event.id}</small></td><td><span className={`status-pill ${event.severity === 'HIGH' || event.severity === 'CRITICAL' ? 'status-disabled' : ''}`}>{event.severity}</span></td><td>{[event.userId, event.deviceId].filter(Boolean).join(' / ') || '—'}</td><td>{event.ip || '—'}</td><td>{event.status}</td><td>{event.status === 'RESOLVED' ? '—' : <button className="text-button" type="button" onClick={() => resolve(event)}>标记已处理</button>}</td></tr>)}
    </tbody></table></div>
  </section>;
}
