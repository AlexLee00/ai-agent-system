'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_ITEMS = [
  { href: '/dashboard',  icon: '🏠', label: '홈' },
  { href: '/employees',  icon: '👥', label: '직원' },
  { href: '/sales',      icon: '💰', label: '매출' },
  { href: '/approvals',  icon: '✅', label: '승인' },
  { href: '/settings',   icon: '⚙️', label: '설정' },
];

export default function BottomNav() {
  const pathname = usePathname();

  return (
    <div className="flex items-center justify-around h-16 px-2">
      {NAV_ITEMS.map(item => {
        const active = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex flex-col items-center gap-0.5 px-3 py-2 rounded-lg min-w-[44px] transition-colors ${
              active ? 'text-primary' : 'text-gray-500'
            }`}
          >
            <span className="text-xl">{item.icon}</span>
            <span className="text-xs font-medium">{item.label}</span>
          </Link>
        );
      })}
    </div>
  );
}
