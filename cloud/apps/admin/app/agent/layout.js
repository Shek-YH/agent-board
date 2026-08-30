import Link from 'next/link';

export default function AgentLayout({ children }) {
  return (
    <div className="admin-shell agent-shell">
      <aside className="sidebar">
        <div className="brand-mark">AB</div>
        <div>
          <span className="eyebrow">AGENT BOARD</span>
          <strong>Agent Portal</strong>
        </div>
        <nav>
          <Link href="/agent/dashboard">概览</Link>
          <Link href="/agent/codes">兑换码</Link>
          <Link href="/agent/batches">发码批次</Link>
          <Link href="/agent/users">体系用户</Link>
          <Link href="/agent/sub-agents">下级代理</Link>
          <Link href="/agent/ledger">额度账本</Link>
          <Link href="/agent/profile">代理资料</Link>
        </nav>
        <Link className="muted back-link" href="/">返回首页</Link>
      </aside>
      <main className="admin-content">{children}</main>
    </div>
  );
}
