'use client';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import Sidebar from '@/components/Sidebar';
import BottomNav from '@/components/BottomNav';
import Header from '@/components/Header';
import WorkerAIWorkspace from '@/components/WorkerAIWorkspace';
import { canAccessMenu, resolveMenuKey } from '@/lib/menu-access';
import { getWorkspaceConfig } from '@/lib/workspace-config';

const PUBLIC_PATHS = ['/login', '/change-password'];

export default function AppShell({ children }) {
  const { user, loading } = useAuth();
  const pathname = usePathname();
  const router   = useRouter();
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (loading) return;
    const isPublic = PUBLIC_PATHS.some(p => pathname.startsWith(p));
    if (!user && !isPublic) router.push('/login');
    if (user  && pathname === '/login') router.push('/dashboard');
    // 비밀번호 강제 변경 가드
    if (user?.must_change_pw && !pathname.startsWith('/change-password')) {
      router.push('/change-password');
    }
    const resolvedMenuKey = resolveMenuKey(pathname);
    if (user && resolvedMenuKey && !isPublic && !canAccessMenu(user, resolvedMenuKey)) {
      router.push('/dashboard');
    }
  }, [user, loading, pathname, router]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const nextDraft = new URLSearchParams(window.location.search).get('prompt') || '';
    setDraft((prev) => (prev === nextDraft ? prev : nextDraft));
  });

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

  const workspace = getWorkspaceConfig(pathname, user);
  const hideGlobalWorkspaceMenus = new Set(['dashboard', 'attendance', 'schedules', 'journals', 'sales', 'projects', 'employees', 'payroll']);
  const hideGlobalWorkspace = hideGlobalWorkspaceMenus.has(workspace.menuKey);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* PC 사이드바 */}
      <aside className="hidden lg:fixed lg:flex lg:flex-col lg:inset-y-0 lg:w-60 bg-white border-r shadow-sm z-30">
        <Sidebar />
      </aside>

      {/* 메인 영역 */}
      <div className="lg:pl-60">
        <Header />
        <main className="p-4 pb-24 lg:pb-6 min-h-[calc(100vh-4rem)]">
          {!hideGlobalWorkspace && (
            <div className="mb-6">
              <WorkerAIWorkspace
                menuKey={workspace.menuKey}
                title={workspace.title}
                description={workspace.description}
                suggestions={workspace.suggestions}
                allowUpload={workspace.allowUpload}
                agentName={workspace.agentName}
                externalDraft={draft}
                draftVersion={draft ? draft.length : 0}
              />
            </div>
          )}
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
