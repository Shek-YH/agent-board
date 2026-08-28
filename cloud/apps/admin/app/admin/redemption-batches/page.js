'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { apiRequest } from '../../../lib/api';

const emptyForm = { name: '', productId: '', planId: '', quantity: 1, expiresAt: '' };

export default function RedemptionBatchesPage() {
  const router = useRouter();
  const [products, setProducts] = useState({ items: [] });
  const [plans, setPlans] = useState({ items: [] });
  const [batches, setBatches] = useState({ items: [] });
  const [form, setForm] = useState(emptyForm);
  const [issued, setIssued] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [productResult, planResult, batchResult] = await Promise.all([
        apiRequest('/v1/admin/products'),
        apiRequest('/v1/admin/plans'),
        apiRequest('/v1/admin/redemption-batches'),
      ]);
      setProducts(productResult);
      setPlans(planResult);
      setBatches(batchResult);
      if (!form.productId && productResult.items[0]) setForm((current) => ({ ...current, productId: productResult.items[0].id }));
      setError('');
    } catch (requestError) {
      if (requestError.status === 401 || requestError.status === 403) router.replace('/login');
      else setError(requestError.code || requestError.message || '兑换批次加载失败');
    }
  }, [form.productId, router]);

  useEffect(() => { load(); }, [load]);

  async function createBatch(event) {
    event.preventDefault();
    try {
      const result = await apiRequest('/v1/admin/redemption-batches', {
        method: 'POST',
        body: {
          ...form,
          quantity: Number(form.quantity),
          expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : undefined,
        },
      });
      setIssued(result);
      setForm((current) => ({ ...emptyForm, productId: current.productId }));
      await load();
    } catch (requestError) {
      setError(requestError.code || requestError.message || '兑换批次创建失败');
    }
  }

  function downloadCsv() {
    if (!issued?.csv) return;
    const url = URL.createObjectURL(new Blob([issued.csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${issued.batch.name || 'redemption-codes'}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const visiblePlans = plans.items.filter((plan) => !form.productId || plan.productId === form.productId);

  return (
    <section>
      <div className="page-heading">
        <div><span className="eyebrow">REDEMPTION</span><h1>兑换批次</h1><p className="muted">明文兑换码只在本次生成响应中出现，可立即下载 CSV。</p></div>
        <button className="secondary-button" onClick={load} type="button">刷新</button>
      </div>
      {error && <p className="error-message" role="alert">{error}</p>}
      <form className="inline-form" onSubmit={createBatch}>
        <input required placeholder="批次名称" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        <select required value={form.productId} onChange={(event) => setForm({ ...form, productId: event.target.value, planId: '' })}><option value="">选择产品</option>{products.items.map((product) => <option key={product.id} value={product.id}>{product.code}</option>)}</select>
        <select required value={form.planId} onChange={(event) => setForm({ ...form, planId: event.target.value })}><option value="">选择计划</option>{visiblePlans.map((plan) => <option key={plan.id} value={plan.id}>{plan.code}</option>)}</select>
        <input required min="1" max="10000" type="number" placeholder="数量" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} />
        <input type="datetime-local" value={form.expiresAt} onChange={(event) => setForm({ ...form, expiresAt: event.target.value })} />
        <button className="primary-button" type="submit">生成兑换码</button>
      </form>
      {issued && <div className="notice-card"><strong>本次生成的兑换码</strong><button className="secondary-button" onClick={downloadCsv} type="button">下载 CSV</button><div className="issued-codes">{issued.codes.map((item) => <code key={item.id}>{item.code}</code>)}</div></div>}
      <div className="table-card">
        <table>
          <thead><tr><th>批次</th><th>产品</th><th>计划</th><th>数量</th><th>状态</th><th>到期</th></tr></thead>
          <tbody>
            {batches.items.length === 0 && <tr><td colSpan="6" className="empty-state">暂无批次</td></tr>}
            {batches.items.map((batch) => <tr key={batch.id}><td><strong>{batch.name}</strong><small>{batch.id}</small></td><td>{batch.productId}</td><td>{batch.planId}</td><td>{batch.quantity}</td><td><span className="status-pill">{batch.status}</span></td><td>{batch.expiresAt ? new Date(batch.expiresAt).toLocaleString('zh-CN') : '永不过期'}</td></tr>)}
          </tbody>
        </table>
      </div>
    </section>
  );
}
