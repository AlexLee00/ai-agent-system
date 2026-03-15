'use client';

import Link from 'next/link';
import { ArrowRight, BookOpen, Calendar, DollarSign, FolderKanban } from 'lucide-react';

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

export default function DocumentsPage() {
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-xl font-bold text-slate-900">문서 업로드 연결 페이지</h1>
        <p className="text-sm text-slate-500">
          문서 관리는 독립 메뉴 대신 각 업무 메뉴의 프롬프트 업로드 흐름으로 통합되었습니다.
          아래에서 실제 입력 화면으로 이동하세요.
        </p>
      </div>

      <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        일정, 업무, 매출, 프로젝트 메뉴의 로컬 프롬프트에서 파일을 바로 첨부할 수 있습니다.
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ShortcutCard
          href="/schedules"
          icon={Calendar}
          title="일정 관리"
          description="회의 자료나 일정 관련 파일을 첨부해 바로 일정 등록 흐름으로 연결합니다."
        />
        <ShortcutCard
          href="/journals"
          icon={BookOpen}
          title="업무 관리"
          description="보고, 회의록, 작업 메모 파일을 첨부해 업무 기록과 초안 흐름으로 연결합니다."
        />
        <ShortcutCard
          href="/sales"
          icon={DollarSign}
          title="매출 관리"
          description="영수증, 집계 파일을 첨부해 매출 등록과 검토 흐름으로 이어갑니다."
        />
        <ShortcutCard
          href="/projects"
          icon={FolderKanban}
          title="프로젝트 관리"
          description="기획안, 산출물 파일을 첨부해 프로젝트 생성과 수정 흐름으로 이어갑니다."
        />
      </div>
    </div>
  );
}
