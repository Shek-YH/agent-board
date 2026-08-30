'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { apiRequest } from '../../../lib/api';

function formatDate(value) {
  return value ? new Date(value).toLocaleString('zh-CN') : '—';
}

export default function DevicesPage() {
  const router = useRouter();
  const [devices, setDevices] = useState({ items: [] });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDevices(await apiRequest('/v1/admin/devices'));
      setError('');
    } catch (requestError) {
      if (requestError.status === 401 || requestError.status === 403) return router.replace('/login');
      setError(requestError.code || requestError.message || '设备列表加载失败');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => { load(); }, [load]);

  async function revoke(device) {
    try {
      await apiRequest(`/v1/admin/devices/${device.id}/revoke`, { method: 'POST' });
      await load();
    } catch (requestError) {
      setError(requestError.code || requestError.message || '设备撤销失败');
    }
  }

  async function reset(device) {
    try {
      await apiRequest(`/v1/admin/devices/${device.id}/reset`, { method: 'POST' });
      await load();
    } catch (requestError) {
      setError(requestError.code || requestError.message || '设备重置失败');
    }
  }

  return <section>
    <div className="page-heading"><div><span className="eyebrow">DEVICE IDENTITY</span><h1>设备管理</h1><p className="muted">设备私钥永不上传；这里仅管理服务端登记的公钥、安装实例和状态。</p></div><button className="secondary-button" onClick={load} type="button">刷新</button></div>
    {error && <p className="error-message" role="alert">{error}</p>}
    <div className="table-card"><table><thead><tr><th>设备</th><th>用户</th><th>安装 ID</th><th>系统</th><th>状态</th><th>最近在线</th><th>操作</th></tr></thead><tbody>
      {loading && <tr><td colSpan="7" className="empty-state">加载中…</td></tr>}
      {!loading && devices.items.length === 0 && <tr><td colSpan="7" className="empty-state">暂无设备</td></tr>}
      {!loading && devices.items.map((device) => <tr key={device.id}><td><strong>{device.deviceName || '未命名设备'}</strong><small>{device.id}</small></td><td>{device.userId}</td><td><code>{device.installationId}</code></td><td>{[device.os, device.osVersion].filter(Boolean).join(' ') || '—'}</td><td><span className={`status-pill ${device.status !== 'ACTIVE' ? 'status-disabled' : ''}`}>{device.status}</span></td><td>{formatDate(device.lastSeenAt)}</td><td>{device.status === 'REVOKED' ? '—' : <><button className="text-button" type="button" onClick={() => revoke(device)}>撤销</button><button className="text-button table-action-button" type="button" onClick={() => reset(device)}>重置</button></>}</td></tr>)}
    </tbody></table></div>
  </section>;
}
