'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import {
  LayoutDashboard, Users, Clock, DollarSign,
  BookOpen, FileText, CheckSquare, Settings,
  Building2, UserCog,
} from 'lucide-react';

const NAV_ITEMS = [
  { href: '/dashboard',  icon: LayoutDashboard, label: '대시보드' },
  { href: '/employees',  icon: Users,           label: '직원 관리' },
  { href: '/attendance', icon: Clock,           label: '근태 관리' },
  { href: '/sales',      icon: DollarSign,      label: '매출 관리' },
  { href: '/journals',   icon: BookOpen,        label: '업무일지' },
  { href: '/documents',  icon: FileText,        label: '문서 관리' },
  { href: '/approvals',  icon: CheckSquare,     label: '승인 관리' },
  { href: '/settings',   icon: Settings,        label: '설정' },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();

  return (
    <div className="flex flex-col h-full">
      {/* 로고 */}
      <div className="p-6 border-b">
        <h1 className="text-xl font-bold text-primary">💼 워커</h1>
        <p className="text-xs text-gray-500 mt-1">업무관리 시스템</p>
      </div>

      {/* 네비 */}
      <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
        {NAV_ITEMS.map(item => {
          const active = pathname.startsWith(item.href);
          const Icon   = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                active
                  ? 'bg-indigo-50 text-indigo-600'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              <Icon className={`w-5 h-5 shrink-0 ${active ? 'text-indigo-600' : 'text-gray-400'}`} />
              {item.label}
            </Link>
          );
        })}

        {/* 마스터 전용 메뉴 */}
        {user?.role === 'master' && (
          <>
            <div className="pt-3 pb-1">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide px-3">관리자</p>
            </div>
            {[
              { href: '/admin/companies', icon: Building2, label: '업체 관리' },
              { href: '/admin/users',     icon: UserCog,   label: '사용자 관리' },
            ].map(item => {
              const active = pathname.startsWith(item.href);
              const Icon   = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    active
                      ? 'bg-purple-50 text-purple-700'
                      : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  <Icon className={`w-5 h-5 shrink-0 ${active ? 'text-purple-600' : 'text-gray-400'}`} />
                  {item.label}
                </Link>
              );
            })}
          </>
        )}
      </nav>

      {/* 사용자 */}
      {user && (
        <div className="p-4 border-t">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-8 h-8 bg-primary rounded-full flex items-center justify-center text-white text-sm font-bold">
              {(user.name || user.username).charAt(0)}
            </div>
            <div>
              <p className="text-sm font-medium">{user.name || user.username}</p>
              <span className={`badge-${user.role}`}>{user.role}</span>
            </div>
          </div>
          <button
            onClick={logout}
            className="w-full text-left text-xs text-gray-500 hover:text-red-500 transition-colors"
          >
            로그아웃
          </button>
        </div>
      )}
    </div>
  );
}
