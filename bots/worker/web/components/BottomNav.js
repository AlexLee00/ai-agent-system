'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { listVisibleMenus } from '@/lib/menu-access';
import { LayoutDashboard, BookOpen, Calendar, Clock, Settings, FileText } from 'lucide-react';

const NAV_ITEMS = [
  { href: '/dashboard',  icon: LayoutDashboard, label: '대시보드' },
  { href: '/attendance', icon: Clock,           label: '근태' },
  { href: '/schedules',  icon: Calendar,        label: '일정' },
  { href: '/documents',  icon: FileText,        label: '문서' },
  { href: '/journals',   icon: BookOpen,        label: '업무' },
  { href: '/settings',   icon: Settings,        label: '설정' },
];

export default function BottomNav() {
  const pathname = usePathname();
  const { user } = useAuth();
  const visibleItems = listVisibleMenus(user, NAV_ITEMS);

  return (
    <div className="flex items-center justify-around h-16 px-2">
      {visibleItems.map(item => {
        const active = pathname.startsWith(item.href);
        const Icon   = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex flex-col items-center gap-0.5 px-3 py-2 rounded-lg min-w-[44px] transition-colors ${
              active ? 'text-indigo-600' : 'text-gray-400'
            }`}
          >
            <Icon className="w-5 h-5" />
            <span className="text-xs font-medium">{item.label}</span>
          </Link>
        );
      })}
    </div>
  );
}
