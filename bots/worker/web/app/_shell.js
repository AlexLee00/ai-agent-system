'use client';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import Sidebar from '@/components/Sidebar';
import BottomNav from '@/components/BottomNav';
import Header from '@/components/Header';
import { canAccessMenu, resolveMenuKey } from '@/lib/menu-access';

const PUBLIC_PATHS = ['/login', '/change-password'];
const ROLE_FALLBACK_ROUTE = {
  member: '/attendance',
  admin: '/dashboard',
  master: '/dashboard',
};

export default function AppShell({ children }) {
  const { user, loading } = useAuth();
  const pathname = usePathname();
  const router   = useRouter();

  useEffect(() => {
    if (loading) return;
    const isPublic = PUBLIC_PATHS.some(p => pathname.startsWith(p));
    if (!user && !isPublic) router.push('/login');
    const fallbackRoute = ROLE_FALLBACK_ROUTE[user?.role] || '/attendance';
    if (user  && pathname === '/login') router.push(fallbackRoute);
    // 비밀번호 강제 변경 가드
    if (user?.must_change_pw && !pathname.startsWith('/change-password')) {
      router.push('/change-password');
    }
    const resolvedMenuKey = resolveMenuKey(pathname);
    if (user && resolvedMenuKey && !isPublic && !canAccessMenu(user, resolvedMenuKey)) {
      router.push(fallbackRoute);
    }
  }, [user, loading, pathname, router]);

  const isPublic = PUBLIC_PATHS.some(p => pathname.startsWith(p));

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin text-3xl">⏳</div>
      </div>
    );
  }

  if (isPublic) return <>{children}</>;

  if (!user) return null;
  return (
    <div className="min-h-screen overflow-x-clip bg-gray-50">
      {/* PC 사이드바 */}
      <aside className="hidden lg:fixed lg:flex lg:flex-col lg:inset-y-0 lg:w-60 bg-white border-r shadow-sm z-30">
        <Sidebar />
      </aside>

      {/* 메인 영역 */}
      <div className="min-w-0 lg:pl-60">
        <Header />
        <main className="min-h-[calc(100vh-3.5rem)] px-3 py-3 pb-[calc(5.5rem+env(safe-area-inset-bottom))] sm:px-4 sm:py-4 lg:min-h-[calc(100vh-4rem)] lg:px-4 lg:py-4 lg:pb-6">
          {children}
        </main>
      </div>

      {/* 모바일 하단 네비 */}
      <nav className="lg:hidden fixed bottom-0 inset-x-0 bg-white border-t shadow-lg z-40 safe-area-pb">
        <BottomNav />
      </nav>
    </div>
  );
}
