'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { apiRequest } from '../../lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await apiRequest('/v1/auth/sign-in/email', { method: 'POST', body: form });
      router.replace('/admin/users');
    } catch (requestError) {
      setError(requestError.code || requestError.message || '登录失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center-stage">
      <form className="form-card" onSubmit={submit}>
        <span className="eyebrow">SECURE ACCESS</span>
        <h1>管理员登录</h1>
        <p className="muted">登录状态由 Secure、HttpOnly Cookie 维护。</p>
        <label>
          邮箱
          <input
            required
            type="email"
            autoComplete="username"
            value={form.email}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
          />
        </label>
        <label>
          密码
          <input
            required
            type="password"
            autoComplete="current-password"
            value={form.password}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
          />
        </label>
        {error && <p className="error-message" role="alert">{error}</p>}
        <button className="primary-button" disabled={busy} type="submit">
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </main>
  );
}
