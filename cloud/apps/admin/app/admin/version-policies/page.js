'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { apiRequest } from '../../../lib/api';

const emptyForm = { productId: '', latestVersion: '', minimumVersion: '', forceUpgradeBelow: '', downloadUrl: '', message: '' };

export default function VersionPoliciesPage() {
  const router = useRouter();
  const [products, setProducts] = useState({ items: [] });
  const [policies, setPolicies] = useState({ items: [] });
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [productResult, policyResult] = await Promise.all([
        apiRequest('/v1/admin/products'),
        apiRequest('/v1/admin/version-policies'),
      ]);
      setProducts(productResult);
      setPolicies(policyResult);
      if (!form.productId && productResult.items[0]) setForm((current) => ({ ...current, productId: productResult.items[0].id }));
      setError('');
    } catch (requestError) {
      if (requestError.status === 401 || requestError.status === 403) return router.replace('/login');
      setError(requestError.code || requestError.message || '版本策略加载失败');
    }
  }, [form.productId, router]);

  useEffect(() => { load(); }, [load]);

  async function createPolicy(event) {
    event.preventDefault();
    try {
      await apiRequest('/v1/admin/version-policies', {
        method: 'POST',
        body: { ...form, forceUpgradeBelow: form.forceUpgradeBelow || null, downloadUrl: form.downloadUrl || null, message: form.message || null },
      });
      setForm((current) => ({ ...emptyForm, productId: current.productId }));
      await load();
    } catch (requestError) {
      setError(requestError.code || requestError.message || '版本策略创建失败');
    }
  }

  return <section>
    <div className="page-heading"><div><span className="eyebrow">CLIENT POLICY</span><h1>版本策略</h1><p className="muted">最低版本会阻止新 Lease，升级提示由云端策略下发。</p></div><button className="secondary-button" onClick={load} type="button">刷新</button></div>
    {error && <p className="error-message" role="alert">{error}</p>}
    <form className="inline-form" onSubmit={createPolicy}>
      <select required value={form.productId} onChange={(event) => setForm({ ...form, productId: event.target.value })}><option value="">选择产品</option>{products.items.map((product) => <option key={product.id} value={product.id}>{product.code}</option>)}</select>
      <input required placeholder="最新版本" value={form.latestVersion} onChange={(event) => setForm({ ...form, latestVersion: event.target.value })} />
      <input required placeholder="最低版本" value={form.minimumVersion} onChange={(event) => setForm({ ...form, minimumVersion: event.target.value })} />
      <input placeholder="强制升级低于" value={form.forceUpgradeBelow} onChange={(event) => setForm({ ...form, forceUpgradeBelow: event.target.value })} />
      <button className="primary-button" type="submit">创建策略</button>
    </form>
    <div className="table-card"><table><thead><tr><th>产品</th><th>最新</th><th>最低</th><th>强制升级低于</th><th>状态</th><th>下载地址</th></tr></thead><tbody>
      {policies.items.length === 0 && <tr><td colSpan="6" className="empty-state">暂无版本策略</td></tr>}
      {policies.items.map((policy) => <tr key={policy.id}><td>{policy.productId}</td><td>{policy.latestVersion}</td><td>{policy.minimumVersion}</td><td>{policy.forceUpgradeBelow || '—'}</td><td><span className="status-pill">{policy.status}</span></td><td>{policy.downloadUrl || '—'}</td></tr>)}
    </tbody></table></div>
  </section>;
}
