import './globals.css';
import { AuthProvider } from '@/lib/auth-context';
import AppShell from './_shell';
import ServiceWorkerReset from '@/components/ServiceWorkerReset';

export const metadata = {
  title: '워커 업무관리',
  description: '워커팀 업무 자동화 시스템',
  icons: {
    icon: '/worker-favicon.svg',
    shortcut: '/worker-favicon.svg',
    apple: '/worker-favicon.svg',
  },
};

export const viewport = {
  themeColor: '#3B82F6',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <head />
      <body>
        <ServiceWorkerReset />
        <AuthProvider>
          <AppShell>{children}</AppShell>
        </AuthProvider>
      </body>
    </html>
  );
}
