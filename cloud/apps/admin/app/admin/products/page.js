'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { apiRequest } from '../../../lib/api';

export default function ProductsPage() {
  const router = useRouter();
  const [products, setProducts] = useState({ items: [] });
  const [form, setForm] = useState({ code: '', name: '' });
  const [error, setError] = useState('');

  const loadProducts = useCallback(async () => {
    try {
      setProducts(await apiRequest('/v1/admin/products'));
      setError('');
    } catch (requestError) {
      if (requestError.status === 401 || requestError.status === 403) router.replace('/login');
      else setError(requestError.code || requestError.message || '产品加载失败');
    }
  }, [router]);

  useEffect(() => { loadProducts(); }, [loadProducts]);

  async function createProduct(event) {
    event.preventDefault();
    try {
      await apiRequest('/v1/admin/products', { method: 'POST', body: form });
      setForm({ code: '', name: '' });
      await loadProducts();
    } catch (requestError) {
      setError(requestError.code || requestError.message || '产品创建失败');
    }
  }

  async function toggleStatus(product) {
    try {
      await apiRequest(`/v1/admin/products/${product.id}`, {
        method: 'PATCH',
        body: { status: product.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' },
      });
      await loadProducts();
    } catch (requestError) {
      setError(requestError.code || requestError.message || '产品状态更新失败');
    }
  }

  return (
    <section>
      <div className="page-heading">
        <div><span className="eyebrow">CATALOG</span><h1>产品</h1><p className="muted">产品是计划和授权的业务边界。</p></div>
        <button className="secondary-button" onClick={loadProducts} type="button">刷新</button>
      </div>
      {error && <p className="error-message" role="alert">{error}</p>}
      <form className="inline-form" onSubmit={createProduct}>
        <input required placeholder="产品 Code" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} />
        <input required placeholder="产品名称" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        <button className="primary-button" type="submit">创建产品</button>
      </form>
      <div className="table-card">
        <table>
          <thead><tr><th>Code</th><th>名称</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead>
          <tbody>
            {products.items.length === 0 && <tr><td colSpan="5" className="empty-state">暂无产品</td></tr>}
            {products.items.map((product) => <tr key={product.id}><td><strong>{product.code}</strong></td><td>{product.name}</td><td><span className={`status-pill ${product.status !== 'ACTIVE' ? 'status-disabled' : ''}`}>{product.status}</span></td><td>{new Date(product.createdAt).toLocaleString('zh-CN')}</td><td><button className="text-button" onClick={() => toggleStatus(product)} type="button">{product.status === 'ACTIVE' ? '禁用' : '启用'}</button></td></tr>)}
          </tbody>
        </table>
      </div>
    </section>
  );
}
