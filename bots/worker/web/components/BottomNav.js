'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { listVisibleMenus } from '@/lib/menu-access';
import { LayoutDashboard, BookOpen, Calendar, Clock, Settings, Video } from 'lucide-react';

const NAV_ITEMS = [
  { href: '/dashboard',  icon: LayoutDashboard, label: '대시보드' },
  { href: '/attendance', icon: Clock,           label: '근태' },
  { href: '/schedules',  icon: Calendar,        label: '일정' },
  { href: '/video',      icon: Video,           label: '영상' },
  { href: '/work-journals', icon: BookOpen,     label: '업무' },
  { href: '/settings',   icon: Settings,        label: '설정' },
];

export default function BottomNav() {
  const pathname = usePathname();
  const { user } = useAuth();
  const visibleItems = listVisibleMenus(user, NAV_ITEMS);

  return (
    <div className="flex h-[calc(4rem+env(safe-area-inset-bottom))] items-center justify-around px-1 pb-[env(safe-area-inset-bottom)] pt-1">
      {visibleItems.map(item => {
        const active = pathname.startsWith(item.href);
        const Icon   = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg px-2 py-2 transition-colors ${
              active ? 'text-indigo-600' : 'text-gray-400'
            }`}
          >
            <Icon className="h-5 w-5 shrink-0" />
            <span className="max-w-full truncate text-[11px] font-medium leading-tight">{item.label}</span>
          </Link>
        );
      })}
    </div>
  );
}
