'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const DEFAULT_ITEMS = [
  { href: '/approvals', label: '승인 관리' },
  { href: '/ai', label: 'AI 분석' },
  { href: '/employees', label: '직원 관리' },
  { href: '/payroll', label: '급여 관리' },
  { href: '/admin/intents', label: '인텐트 학습' },
  { href: '/admin/companies', label: '업체 관리' },
  { href: '/admin/users', label: '사용자 관리' },
];

export default function AdminQuickNav({ items = DEFAULT_ITEMS, title = '운영 바로가기' }) {
  const pathname = usePathname();

  return (
    <div className="card bg-white">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-slate-500">{title}</p>
          <p className="mt-1 text-xs text-slate-400">관리자 운영 화면을 빠르게 오갈 수 있습니다.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {items.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  active
                    ? 'bg-slate-900 text-white'
                    : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
