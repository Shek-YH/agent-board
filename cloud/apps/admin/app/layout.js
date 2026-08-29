import './globals.css';

export const metadata = {
  title: 'Agent Board Admin',
  description: 'Agent Board 云端管理后台',
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
