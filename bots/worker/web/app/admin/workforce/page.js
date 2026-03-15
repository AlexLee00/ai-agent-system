'use client';

import Link from 'next/link';
import { ArrowRight, Users, Wallet } from 'lucide-react';

function ShortcutCard({ href, icon: Icon, title, description }) {
  return (
    <Link href={href} className="card hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-lg font-semibold text-slate-900">{title}</p>
          <p className="mt-2 text-sm text-slate-500">{description}</p>
        </div>
        <div className="w-11 h-11 rounded-2xl bg-slate-100 flex items-center justify-center text-slate-700">
          <Icon className="w-5 h-5" />
        </div>
      </div>
      <div className="mt-4 flex items-center gap-2 text-sm font-medium text-slate-700">
        바로 이동
        <ArrowRight className="w-4 h-4" />
      </div>
    </Link>
  );
}

export default function WorkforcePage() {
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-xl font-bold text-slate-900">직원/급여 관리 연결 페이지</h1>
        <p className="text-sm text-slate-500">
          기존 통합 경로는 더 이상 주 메뉴로 사용하지 않습니다. 아래에서 실제 관리 화면으로 이동하세요.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ShortcutCard
          href="/employees"
          icon={Users}
          title="직원 관리"
          description="직원 등록, 수정, 상태 확인, 자연어 제안 흐름을 관리합니다."
        />
        <ShortcutCard
          href="/payroll"
          icon={Wallet}
          title="급여 관리"
          description="급여 계산, 확정, 명세 흐름과 승인 대기를 관리합니다."
        />
      </div>
    </div>
  );
}
