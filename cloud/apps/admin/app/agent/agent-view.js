'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { apiRequest } from '../../lib/api';

const pageMeta = {
  dashboard: ['AGENT PORTAL', '代理概览', '/v1/agent/me'],
  codes: ['REDEMPTION', '体系兑换码', '/v1/agent/codes'],
  batches: ['REDEMPTION', '发码批次', '/v1/agent/batches'],
  users: ['DATA SCOPE', '体系用户', '/v1/agent/users'],
  'sub-agents': ['HIERARCHY', '下级代理', '/v1/agent/sub-agents'],
  ledger: ['LEDGER', '额度账本', '/v1/agent/ledger'],
  profile: ['AGENT', '代理资料', '/v1/agent/profile'],
};

function displayDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
}

function errorMessage(error) {
  return error.code || error.message || '请求失败';
}

export default function AgentView({ mode }) {
  const router = useRouter();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ name: '', productId: '', planId: '', quantity: '1', userId: '' });
  const [issued, setIssued] = useState(null);
  const meta = pageMeta[mode] || pageMeta.dashboard;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiRequest(meta[2]));
      setError('');
    } catch (requestError) {
      if (requestError.status === 401 || requestError.status === 403) {
        router.replace('/login');
        return;
      }
      setError(errorMessage(requestError));
    } finally {
      setLoading(false);
    }
  }, [meta, router]);

  useEffect(() => { load(); }, [load]);

  async function createBatch(event) {
    event.preventDefault();
    try {
      const result = await apiRequest('/v1/agent/batches', {
        method: 'POST',
        body: { name: form.name, productId: form.productId, planId: form.planId, quantity: Number(form.quantity) },
      });
      setIssued(result);
      setForm({ ...form, name: '' });
      await load();
    } catch (requestError) {
      setError(errorMessage(requestError));
    }
  }

  async function createSubAgent(event) {
    event.preventDefault();
    try {
      await apiRequest('/v1/agent/sub-agents', { method: 'POST', body: { userId: form.userId } });
      setForm({ ...form, userId: '' });
      await load();
    } catch (requestError) {
      setError(errorMessage(requestError));
    }
  }

  const items = data?.items || [];
  return (
    <section>
      <div className="page-heading">
        <div>
          <span className="eyebrow">{meta[0]}</span>
          <h1>{meta[1]}</h1>
          <p className="muted">数据范围由云端 API 强制校验，只展示当前代理体系允许访问的记录。</p>
        </div>
        <button className="secondary-button" onClick={load} type="button">刷新</button>
      </div>
      {error && <p className="error-message" role="alert">{error}</p>}
      {mode === 'dashboard' && <Dashboard data={data} />}
      {mode === 'batches' && <BatchContent data={data} form={form} setForm={setForm} onSubmit={createBatch} issued={issued} />}
      {mode === 'sub-agents' && <SubAgentContent data={data} form={form} setForm={setForm} onSubmit={createSubAgent} />}
      {mode === 'profile' && <ProfileContent data={data} />}
      {!['dashboard', 'batches', 'sub-agents', 'profile'].includes(mode) && <ItemsTable mode={mode} items={items} loading={loading} />}
      {loading && mode === 'dashboard' && <p className="muted">加载中…</p>}
    </section>
  );
}

function Dashboard({ data }) {
  const agent = data?.agent || {};
  const stats = [
    ['当前额度', data?.balance ?? 0],
    ['下级代理', data?.subAgentCount ?? 0],
    ['体系用户', data?.userCount ?? 0],
    ['未使用码', data?.unusedCodeCount ?? 0],
  ];
  return <>
    <div className="agent-stat-grid">{stats.map(([label, value]) => <div className="agent-stat-card" key={label}><strong>{value}</strong><span>{label}</span></div>)}</div>
    <div className="notice-card"><strong>代理身份</strong><span>{agent.id || '—'} · {agent.status || '—'} · Level {agent.level ?? '—'}</span></div>
  </>;
}

function BatchContent({ data, form, setForm, onSubmit, issued }) {
  return <>
    <form className="inline-form" onSubmit={onSubmit}>
      <input required placeholder="批次名称" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      <input required placeholder="产品 ID" value={form.productId} onChange={(event) => setForm({ ...form, productId: event.target.value })} />
      <input required placeholder="计划 ID" value={form.planId} onChange={(event) => setForm({ ...form, planId: event.target.value })} />
      <input required min="1" type="number" placeholder="数量" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} />
      <button className="primary-button" type="submit">生成兑换码</button>
    </form>
    {issued?.codes?.length > 0 && <div className="notice-card"><strong>本次明文只显示一次，请立即保存</strong><div className="issued-codes">{issued.codes.map((item) => <code key={item.id}>{item.code}</code>)}</div><button className="secondary-button" type="button" onClick={() => { const blob = new Blob([issued.csv], { type: 'text/csv;charset=utf-8' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${issued.batch?.id || 'redemption-batch'}.csv`; link.click(); URL.revokeObjectURL(url); }}>下载 CSV</button></div>}
    <ItemsTable mode="batches" items={data?.items || []} />
  </>;
}

function SubAgentContent({ data, form, setForm, onSubmit }) {
  return <>
    <form className="inline-form" onSubmit={onSubmit}>
      <input required placeholder="已存在的代理用户 ID" value={form.userId} onChange={(event) => setForm({ ...form, userId: event.target.value })} />
      <button className="primary-button" type="submit">创建下级代理</button>
    </form>
    <ItemsTable mode="sub-agents" items={data?.items || []} />
  </>;
}

function ProfileContent({ data }) {
  const agent = data?.agent || data || {};
  return <div className="table-card agent-profile"><dl>{Object.entries(agent).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—')}</dd></div>)}</dl></div>;
}

function ItemsTable({ mode, items, loading }) {
  const columns = mode === 'ledger'
    ? ['type', 'amount', 'balanceAfter', 'reason', 'createdAt']
    : mode === 'codes'
      ? ['codeLast4', 'status', 'planId', 'createdAt']
      : ['id', mode === 'users' ? 'email' : mode === 'sub-agents' ? 'level' : 'name', 'status', 'createdAt'];
  return <div className="table-card"><table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>
    {loading && <tr><td colSpan={columns.length} className="empty-state">加载中…</td></tr>}
    {!loading && items.length === 0 && <tr><td colSpan={columns.length} className="empty-state">暂无记录</td></tr>}
    {!loading && items.map((item, index) => <tr key={item.id || index}>{columns.map((column) => <td key={column}>{column === 'createdAt' ? displayDate(item[column]) : String(item[column] ?? '—')}</td>)}</tr>)}
  </tbody></table></div>;
}
