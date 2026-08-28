import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="center-stage">
      <section className="hero-card">
        <span className="eyebrow">AGENT BOARD / CLOUD</span>
        <h1>云端管理后台</h1>
        <p>管理用户、角色和可追溯的业务操作记录。</p>
        <Link className="primary-button" href="/login">进入登录</Link>
      </section>
    </main>
  );
}
