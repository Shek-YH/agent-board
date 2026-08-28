'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { apiRequest } from '../../../lib/api';

const roles = ['USER', 'AGENT', 'ADMIN', 'SUPER_ADMIN'];

export default function UsersPage() {
  const router = useRouter();
  const [users, setUsers] = useState({ items: [], meta: null });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [newUser, setNewUser] = useState({ name: '', email: '', password: '' });

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      setUsers(await apiRequest('/v1/admin/users'));
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
  }, [router]);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  async function updateRole(user, role) {
    await apiRequest(`/v1/admin/users/${user.id}`, { method: 'PATCH', body: { role } });
    await loadUsers();
  }

  async function toggleStatus(user) {
    const action = user.profile?.status === 'DISABLED' ? 'enable' : 'disable';
    await apiRequest(`/v1/admin/users/${user.id}/${action}`, { method: 'POST' });
    await loadUsers();
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
                <td><strong>{user.name}</strong><small>{user.id}</small></td>
                <td>{user.email}</td>
                <td>
                  <select value={user.profile?.role || 'USER'} onChange={(event) => updateRole(user, event.target.value)}>
                    {roles.map((role) => <option key={role}>{role}</option>)}
                  </select>
                </td>
                <td><span className={`status-pill ${user.profile?.status === 'DISABLED' ? 'status-disabled' : ''}`}>{user.profile?.status || 'ACTIVE'}</span></td>
                <td><button className="text-button" onClick={() => toggleStatus(user)} type="button">{user.profile?.status === 'DISABLED' ? '启用' : '禁用'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {users.meta && <p className="muted table-footer">共 {users.meta.total} 个用户</p>}
    </section>
  );
}
