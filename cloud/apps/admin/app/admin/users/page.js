'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { apiRequest } from '../../../lib/api';

const roles = ['USER', 'AGENT', 'ADMIN', 'SUPER_ADMIN'];

export default function UsersPage() {
  const router = useRouter();
  const [users, setUsers] = useState({ items: [], meta: null });
  const [filters, setFilters] = useState({ search: '', status: '', page: 1 });
  const [draftFilters, setDraftFilters] = useState({ search: '', status: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [newUser, setNewUser] = useState({ name: '', email: '', password: '' });

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(filters.page), pageSize: '20' });
      if (filters.search) params.set('search', filters.search);
      if (filters.status) params.set('status', filters.status);
      setUsers(await apiRequest(`/v1/admin/users?${params.toString()}`));
      setError('');
    } catch (requestError) {
      if (requestError.status === 401 || requestError.status === 403) {
        router.replace('/login');
        return;
      }
      setError(requestError.code || requestError.message || '用户列表加载失败');
    } finally {
      setLoading(false);
    }
  }, [filters, router]);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  async function updateRole(user, role) {
    await apiRequest(`/v1/admin/users/${user.id}`, { method: 'PATCH', body: { role } });
    await loadUsers();
  }

  async function toggleStatus(user) {
    const currentStatus = user.profile?.status || 'ACTIVE';
    const action = currentStatus === 'DISABLED' || currentStatus === 'SUSPENDED' ? 'enable' : 'disable';
    try {
      await apiRequest(`/v1/admin/users/${user.id}/${action}`, { method: 'POST' });
      await loadUsers();
    } catch (requestError) {
      setError(requestError.code || requestError.message || '用户状态更新失败');
    }
  }

  async function suspend(user) {
    try {
      await apiRequest(`/v1/admin/users/${user.id}/suspend`, { method: 'POST' });
      await loadUsers();
    } catch (requestError) {
      setError(requestError.code || requestError.message || '用户暂停失败');
    }
  }

  async function createUser(event) {
    event.preventDefault();
    await apiRequest('/v1/admin/users', { method: 'POST', body: newUser });
    setNewUser({ name: '', email: '', password: '' });
    await loadUsers();
  }

  return (
    <section>
      <div className="page-heading">
        <div>
          <span className="eyebrow">DIRECTORY</span>
          <h1>用户管理</h1>
          <p className="muted">角色和状态变更都会写入审计日志。</p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button" onClick={loadUsers} type="button">刷新</button>
          <details className="new-user-details">
            <summary className="primary-button">新建用户</summary>
            <form className="new-user-form" onSubmit={createUser}>
              <input required placeholder="姓名" value={newUser.name} onChange={(event) => setNewUser({ ...newUser, name: event.target.value })} />
              <input required type="email" placeholder="邮箱" value={newUser.email} onChange={(event) => setNewUser({ ...newUser, email: event.target.value })} />
              <input required minLength="8" type="password" placeholder="初始密码" value={newUser.password} onChange={(event) => setNewUser({ ...newUser, password: event.target.value })} />
              <button className="primary-button" type="submit">创建</button>
            </form>
          </details>
        </div>
      </div>
      {error && <p className="error-message" role="alert">{error}</p>}
      <form className="inline-form" onSubmit={(event) => { event.preventDefault(); setFilters({ ...draftFilters, page: 1 }); }}>
        <input placeholder="搜索姓名或邮箱" value={draftFilters.search} onChange={(event) => setDraftFilters((current) => ({ ...current, search: event.target.value }))} />
        <select value={draftFilters.status} onChange={(event) => setDraftFilters((current) => ({ ...current, status: event.target.value }))}><option value="">全部状态</option><option>ACTIVE</option><option>SUSPENDED</option><option>DISABLED</option></select>
        <button className="secondary-button" type="submit">搜索</button>
      </form>
      <div className="table-card">
        <table>
          <thead>
            <tr><th>用户</th><th>邮箱</th><th>角色</th><th>状态</th><th>操作</th></tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan="5" className="empty-state">加载中…</td></tr>}
            {!loading && users.items.length === 0 && <tr><td colSpan="5" className="empty-state">暂无用户</td></tr>}
            {!loading && users.items.map((user) => (
              <tr key={user.id}>
                <td><strong><a href={`/admin/users/${user.id}`}>{user.name}</a></strong><small>{user.id}</small></td>
                <td>{user.email}</td>
                <td>
                  <select value={user.profile?.role || 'USER'} onChange={(event) => updateRole(user, event.target.value)}>
                    {roles.map((role) => <option key={role}>{role}</option>)}
                  </select>
                </td>
                <td><span className={`status-pill ${user.profile?.status !== 'ACTIVE' ? 'status-disabled' : ''}`}>{user.profile?.status || 'ACTIVE'}</span></td>
                <td>
                  {(user.profile?.status === 'DISABLED' || user.profile?.status === 'SUSPENDED')
                    ? <button className="text-button" onClick={() => toggleStatus(user)} type="button">启用</button>
                    : <><button className="text-button" onClick={() => suspend(user)} type="button">暂停</button><button className="text-button table-action-button" onClick={() => toggleStatus(user)} type="button">禁用</button></>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {users.meta && <div className="table-footer"><span className="muted">第 {users.meta.page} 页，共 {users.meta.total} 个用户</span><span className="heading-actions"><button className="secondary-button" disabled={users.meta.page <= 1} onClick={() => setFilters((current) => ({ ...current, page: current.page - 1 }))} type="button">上一页</button><button className="secondary-button" disabled={users.meta.page * users.meta.pageSize >= users.meta.total} onClick={() => setFilters((current) => ({ ...current, page: current.page + 1 }))} type="button">下一页</button></span></div>}
    </section>
  );
}
