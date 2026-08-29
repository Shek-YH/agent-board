'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { apiRequest } from '../../../lib/api';

export default function RedemptionCodesPage() {
  const router = useRouter();
  const [codes, setCodes] = useState({ items: [] });
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setCodes(await apiRequest('/v1/admin/redemption-codes'));
      setError('');
    } catch (requestError) {
      if (requestError.status === 401 || requestError.status === 403) router.replace('/login');
      else setError(requestError.code || requestError.message || '兑换码加载失败');
    }
  }, [router]);

  useEffect(() => { load(); }, [load]);

  async function revoke(id) {
    try {
      await apiRequest(`/v1/admin/redemption-codes/${id}/revoke`, { method: 'POST' });
      await load();
    } catch (requestError) {
      setError(requestError.code || requestError.message || '兑换码撤销失败');
    }
  }

  return (
    <section>
      <div className="page-heading"><div><span className="eyebrow">REDEMPTION</span><h1>兑换码</h1><p className="muted">历史列表只显示末四位，不保存或展示完整明文。</p></div><button className="secondary-button" onClick={load} type="button">刷新</button></div>
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="table-card">
        <table>
          <thead><tr><th>末四位</th><th>批次</th><th>计划</th><th>状态</th><th>兑换用户</th><th>操作</th></tr></thead>
          <tbody>
            {codes.items.length === 0 && <tr><td colSpan="6" className="empty-state">暂无兑换码</td></tr>}
            {codes.items.map((item) => <tr key={item.id}><td><strong>••••{item.codeLast4}</strong></td><td>{item.batchId}</td><td>{item.planId}</td><td><span className="status-pill">{item.status}</span></td><td>{item.redeemedByUserId || '—'}</td><td>{item.status === 'UNUSED' && <button className="text-button" onClick={() => revoke(item.id)} type="button">撤销</button>}</td></tr>)}
          </tbody>
        </table>
      </div>
    </section>
  );
}
