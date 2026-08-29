'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { apiRequest } from '../../../lib/api';

const emptyForm = { productId: '', code: '', name: '', durationSeconds: '' };

export default function PlansPage() {
  const router = useRouter();
  const [products, setProducts] = useState({ items: [] });
  const [plans, setPlans] = useState({ items: [] });
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [productResult, planResult] = await Promise.all([
        apiRequest('/v1/admin/products'),
        apiRequest('/v1/admin/plans'),
      ]);
      setProducts(productResult);
      setPlans(planResult);
      if (!form.productId && productResult.items[0]) setForm((current) => ({ ...current, productId: productResult.items[0].id }));
      setError('');
    } catch (requestError) {
      if (requestError.status === 401 || requestError.status === 403) router.replace('/login');
      else setError(requestError.code || requestError.message || '计划加载失败');
    }
  }, [form.productId, router]);

  useEffect(() => { load(); }, [load]);

  async function createPlan(event) {
    event.preventDefault();
    try {
      await apiRequest('/v1/admin/plans', {
        method: 'POST',
        body: { ...form, durationSeconds: Number(form.durationSeconds) },
      });
      setForm((current) => ({ ...emptyForm, productId: current.productId }));
      await load();
    } catch (requestError) {
      setError(requestError.code || requestError.message || '计划创建失败');
    }
  }

  return (
    <section>
      <div className="page-heading">
        <div><span className="eyebrow">CATALOG</span><h1>计划</h1><p className="muted">授权时长和设备策略均来自计划配置。</p></div>
        <button className="secondary-button" onClick={load} type="button">刷新</button>
      </div>
      {error && <p className="error-message" role="alert">{error}</p>}
      <form className="inline-form" onSubmit={createPlan}>
        <select required value={form.productId} onChange={(event) => setForm({ ...form, productId: event.target.value })}><option value="">选择产品</option>{products.items.map((product) => <option key={product.id} value={product.id}>{product.code}</option>)}</select>
        <input required placeholder="计划 Code" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} />
        <input required placeholder="计划名称" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        <input required min="1" type="number" placeholder="时长（秒）" value={form.durationSeconds} onChange={(event) => setForm({ ...form, durationSeconds: event.target.value })} />
        <button className="primary-button" type="submit">创建计划</button>
      </form>
      <div className="table-card">
        <table>
          <thead><tr><th>计划</th><th>产品</th><th>时长</th><th>设备限制</th><th>状态</th></tr></thead>
          <tbody>
            {plans.items.length === 0 && <tr><td colSpan="5" className="empty-state">暂无计划</td></tr>}
            {plans.items.map((plan) => <tr key={plan.id}><td><strong>{plan.code}</strong><small>{plan.name}</small></td><td>{plan.productId}</td><td>{plan.isPermanent ? '永久' : `${plan.durationSeconds} 秒`}</td><td>{plan.maxRegisteredDevices} 注册 / {plan.maxConcurrentDevices} 在线</td><td><span className="status-pill">{plan.status}</span></td></tr>)}
          </tbody>
        </table>
      </div>
    </section>
  );
}
