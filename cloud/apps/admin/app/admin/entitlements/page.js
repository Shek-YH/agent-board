'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { apiRequest } from '../../../lib/api';

const emptyForm = { userId: '', productId: '', planId: '' };

export default function EntitlementsPage() {
  const router = useRouter();
  const [entitlements, setEntitlements] = useState({ items: [], meta: null });
  const [products, setProducts] = useState({ items: [] });
  const [plans, setPlans] = useState({ items: [] });
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [entitlementResult, productResult, planResult] = await Promise.all([
        apiRequest('/v1/admin/entitlements'),
        apiRequest('/v1/admin/products'),
        apiRequest('/v1/admin/plans'),
      ]);
      setEntitlements(entitlementResult);
      setProducts(productResult);
      setPlans(planResult);
      if (!form.productId && productResult.items[0]) setForm((current) => ({ ...current, productId: productResult.items[0].id }));
      setError('');
    } catch (requestError) {
      if (requestError.status === 401 || requestError.status === 403) router.replace('/login');
      else setError(requestError.code || requestError.message || '授权加载失败');
    }
  }, [form.productId, router]);

  useEffect(() => { load(); }, [load]);

  async function grant(event) {
    event.preventDefault();
    try {
      await apiRequest(`/v1/admin/users/${form.userId}/grants`, {
        method: 'POST',
        body: { productId: form.productId, planId: form.planId || undefined },
      });
      setForm((current) => ({ ...emptyForm, productId: current.productId }));
      await load();
    } catch (requestError) {
      setError(requestError.code || requestError.message || '人工授权失败');
    }
  }

  const visiblePlans = plans.items.filter((plan) => !form.productId || plan.productId === form.productId);

  return (
    <section>
      <div className="page-heading">
        <div><span className="eyebrow">ACCESS</span><h1>授权</h1><p className="muted">选择计划后执行人工授权，时长由计划配置决定。</p></div>
        <button className="secondary-button" onClick={load} type="button">刷新</button>
      </div>
      {error && <p className="error-message" role="alert">{error}</p>}
      <form className="inline-form" onSubmit={grant}>
        <input required placeholder="用户 ID" value={form.userId} onChange={(event) => setForm({ ...form, userId: event.target.value })} />
        <select required value={form.productId} onChange={(event) => setForm({ ...form, productId: event.target.value, planId: '' })}><option value="">选择产品</option>{products.items.map((product) => <option key={product.id} value={product.id}>{product.code}</option>)}</select>
        <select required value={form.planId} onChange={(event) => setForm({ ...form, planId: event.target.value })}><option value="">选择计划</option>{visiblePlans.map((plan) => <option key={plan.id} value={plan.id}>{plan.code}</option>)}</select>
        <button className="primary-button" type="submit">执行授权</button>
      </form>
      <div className="table-card">
        <table>
          <thead><tr><th>用户</th><th>产品</th><th>计划</th><th>状态</th><th>到期时间</th></tr></thead>
          <tbody>
            {entitlements.items.length === 0 && <tr><td colSpan="5" className="empty-state">暂无授权</td></tr>}
            {entitlements.items.map((item) => <tr key={item.id}><td>{item.userId}</td><td>{item.productId}</td><td>{item.planId || '—'}</td><td><span className="status-pill">{item.status}</span></td><td>{item.isPermanent ? '永久' : new Date(item.expiresAt).toLocaleString('zh-CN')}</td></tr>)}
          </tbody>
        </table>
      </div>
    </section>
  );
}
