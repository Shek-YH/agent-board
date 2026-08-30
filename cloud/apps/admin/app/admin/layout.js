import Link from 'next/link';

import LogoutButton from '../logout-button';

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
          <Link href="/admin/dashboard">总览</Link>
          <Link href="/admin/users">用户</Link>
          <Link href="/admin/products">产品</Link>
          <Link href="/admin/plans">计划</Link>
          <Link href="/admin/entitlements">授权</Link>
          <Link href="/admin/agents">代理</Link>
          <Link href="/admin/devices">设备</Link>
          <Link href="/admin/online-sessions">在线会话</Link>
          <Link href="/admin/client-versions">客户端版本</Link>
          <Link href="/admin/version-policies">版本策略</Link>
          <Link href="/admin/redemption-batches">兑换批次</Link>
          <Link href="/admin/redemption-codes">兑换码</Link>
          <Link href="/admin/audit-logs">审计日志</Link>
          <Link href="/admin/security-events">安全事件</Link>
          <Link href="/admin/settings">设置</Link>
        </nav>
        <LogoutButton />
        <Link className="muted back-link" href="/">返回首页</Link>
      </aside>
      <main className="admin-content">{children}</main>
    </div>
  );
}
