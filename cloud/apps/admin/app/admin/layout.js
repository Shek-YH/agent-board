import Link from 'next/link';

export default function AdminLayout({ children }) {
  return (
    <div className="admin-shell">
      <aside className="sidebar">
        <div className="brand-mark">AB</div>
        <div>
          <span className="eyebrow">AGENT BOARD</span>
          <strong>Cloud Admin</strong>
        </div>
        <nav>
          <Link href="/admin/users">用户</Link>
          <Link href="/admin/audit-logs">审计日志</Link>
        </nav>
        <Link className="muted back-link" href="/">返回首页</Link>
      </aside>
      <main className="admin-content">{children}</main>
    </div>
  );
}
