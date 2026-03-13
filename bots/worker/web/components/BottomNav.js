'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, BookOpen, DollarSign, CheckSquare, Settings, Bot } from 'lucide-react';

const NAV_ITEMS = [
  { href: '/dashboard',  icon: LayoutDashboard, label: '홈' },
  { href: '/chat',       icon: Bot,             label: 'AI' },
  { href: '/journals',   icon: BookOpen,        label: '일지' },
  { href: '/sales',      icon: DollarSign,      label: '매출' },
  { href: '/approvals',  icon: CheckSquare,     label: '승인' },
  { href: '/settings',   icon: Settings,        label: '설정' },
];

export default function BottomNav() {
  const pathname = usePathname();

  return (
    <div className="flex items-center justify-around h-16 px-2">
      {NAV_ITEMS.map(item => {
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
