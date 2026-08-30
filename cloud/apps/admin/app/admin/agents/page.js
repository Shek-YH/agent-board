'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { apiRequest } from '../../../lib/api';

const initialForm = { userId: '', parentAgentId: '', canCreateSubAgents: false, maxSubAgentDepth: '', planAllowlist: '' };

export default function AgentsPage() {
  const router = useRouter();
  const [agents, setAgents] = useState({ items: [] });
  const [form, setForm] = useState(initialForm);
  const [ledger, setLedger] = useState({ agentId: '', amount: '', reason: '' });
  const [assignment, setAssignment] = useState({ agentId: '', userId: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setAgents(await apiRequest('/v1/admin/agents'));
      setError('');
    } catch (requestError) {
      if (requestError.status === 401 || requestError.status === 403) return router.replace('/login');
      setError(requestError.code || requestError.message || '代理列表加载失败');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => { load(); }, [load]);

  async function createAgent(event) {
    event.preventDefault();
    try {
      await apiRequest('/v1/admin/agents', {
        method: 'POST',
        body: {
          ...form,
          parentAgentId: form.parentAgentId || null,
          maxSubAgentDepth: form.maxSubAgentDepth === '' ? null : Number(form.maxSubAgentDepth),
          planAllowlist: form.planAllowlist ? form.planAllowlist.split(',').map((item) => item.trim()).filter(Boolean) : [],
        },
      });
      setForm(initialForm);
      await load();
    } catch (requestError) {
      setError(requestError.code || requestError.message || '代理创建失败');
    }
  }

  async function toggle(agent) {
    try {
      await apiRequest(`/v1/admin/agents/${agent.id}`, { method: 'PATCH', body: { canCreateSubAgents: !agent.canCreateSubAgents } });
      await load();
    } catch (requestError) {
      setError(requestError.code || requestError.message || '代理更新失败');
    }
  }

  async function adjustLedger(event) {
    event.preventDefault();
    try {
      await apiRequest(`/v1/admin/agents/${ledger.agentId}/ledger-adjustment`, { method: 'POST', body: { type: 'CREDIT', amount: Number(ledger.amount), reason: ledger.reason } });
      setLedger({ agentId: '', amount: '', reason: '' });
      setError('');
    } catch (requestError) {
      setError(requestError.code || requestError.message || '额度调整失败');
    }
  }

  async function assignUser(event) {
    event.preventDefault();
    try {
      await apiRequest(`/v1/admin/agents/${assignment.agentId}/users/${assignment.userId}`, { method: 'POST' });
      setAssignment({ agentId: '', userId: '' });
      setError('');
    } catch (requestError) {
      setError(requestError.code || requestError.message || '用户归属调整失败');
    }
  }

  return <section>
    <div className="page-heading"><div><span className="eyebrow">HIERARCHY</span><h1>代理管理</h1><p className="muted">上级关系由 API 防循环，额度调整只追加不可变账本记录。</p></div><button className="secondary-button" onClick={load} type="button">刷新</button></div>
    {error && <p className="error-message" role="alert">{error}</p>}
    <form className="inline-form" onSubmit={createAgent}>
      <input required placeholder="代理用户 ID" value={form.userId} onChange={(event) => setForm({ ...form, userId: event.target.value })} />
      <input placeholder="上级代理 ID（可选）" value={form.parentAgentId} onChange={(event) => setForm({ ...form, parentAgentId: event.target.value })} />
      <input min="0" type="number" placeholder="最大下级深度" value={form.maxSubAgentDepth} onChange={(event) => setForm({ ...form, maxSubAgentDepth: event.target.value })} />
      <input placeholder="Plan ID 白名单，逗号分隔" value={form.planAllowlist} onChange={(event) => setForm({ ...form, planAllowlist: event.target.value })} />
      <label className="checkbox-label"><input type="checkbox" checked={form.canCreateSubAgents} onChange={(event) => setForm({ ...form, canCreateSubAgents: event.target.checked })} />允许创建下级</label>
      <button className="primary-button" type="submit">创建代理</button>
    </form>
    <form className="inline-form" onSubmit={adjustLedger}>
      <select required value={ledger.agentId} onChange={(event) => setLedger({ ...ledger, agentId: event.target.value })}><option value="">选择代理</option>{agents.items.map((agent) => <option key={agent.id} value={agent.id}>{agent.id} · Level {agent.level}</option>)}</select>
      <input required min="1" type="number" placeholder="充值额度" value={ledger.amount} onChange={(event) => setLedger({ ...ledger, amount: event.target.value })} />
      <input required placeholder="调整原因" value={ledger.reason} onChange={(event) => setLedger({ ...ledger, reason: event.target.value })} />
      <button className="secondary-button" type="submit">增加额度</button>
    </form>
    <form className="inline-form" onSubmit={assignUser}>
      <select required value={assignment.agentId} onChange={(event) => setAssignment({ ...assignment, agentId: event.target.value })}><option value="">选择代理</option>{agents.items.map((agent) => <option key={agent.id} value={agent.id}>{agent.id}</option>)}</select>
      <input required placeholder="用户 ID" value={assignment.userId} onChange={(event) => setAssignment({ ...assignment, userId: event.target.value })} />
      <button className="secondary-button" type="submit">归属用户</button>
    </form>
    <div className="table-card"><table><thead><tr><th>代理</th><th>上级</th><th>层级</th><th>状态</th><th>创建下级</th><th>操作</th></tr></thead><tbody>
      {loading && <tr><td colSpan="6" className="empty-state">加载中…</td></tr>}
      {!loading && agents.items.length === 0 && <tr><td colSpan="6" className="empty-state">暂无代理</td></tr>}
      {!loading && agents.items.map((agent) => <tr key={agent.id}><td><strong>{agent.id}</strong><small>{agent.userId}</small></td><td>{agent.parentAgentId || '—'}</td><td>{agent.level}</td><td><span className={`status-pill ${agent.status !== 'ACTIVE' ? 'status-disabled' : ''}`}>{agent.status}</span></td><td>{agent.canCreateSubAgents ? '允许' : '禁止'}</td><td><button className="text-button" type="button" onClick={() => toggle(agent)}>{agent.canCreateSubAgents ? '禁止创建' : '允许创建'}</button></td></tr>)}
    </tbody></table></div>
  </section>;
}
