'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { apiRequest } from '../../../lib/api';

export default function AuditLogsPage() {
  const router = useRouter();
  const [result, setResult] = useState({ items: [] });
  const [error, setError] = useState('');

  useEffect(() => {
    apiRequest('/v1/admin/audit-logs')
      .then(setResult)
      .catch((requestError) => {
        if (requestError.status === 401 || requestError.status === 403) router.replace('/login');
        else setError(requestError.code || requestError.message || '审计日志加载失败');
      });
  }, [router]);

  return (
    <section>
      <div className="page-heading">
        <div><span className="eyebrow">TRACEABILITY</span><h1>审计日志</h1><p className="muted">敏感字段在写入前已脱敏。</p></div>
      </div>
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="table-card">
        <table>
          <thead><tr><th>时间</th><th>操作</th><th>操作者</th><th>目标</th><th>变更</th></tr></thead>
          <tbody>
            {result.items.length === 0 && <tr><td colSpan="5" className="empty-state">暂无审计记录</td></tr>}
            {result.items.map((item) => (
              <tr key={item.id}>
                <td>{new Date(item.createdAt).toLocaleString('zh-CN')}</td>
                <td><strong>{item.action}</strong></td>
                <td>{item.actorId}</td>
                <td>{item.targetType} / {item.targetId || '—'}</td>
                <td><code>{JSON.stringify(item.afterSanitized || {})}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
