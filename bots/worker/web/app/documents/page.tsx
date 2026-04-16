// @ts-nocheck
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, BookOpen, Calendar, DollarSign, FileText, FolderKanban } from 'lucide-react';
import { api } from '@/lib/api';

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

function formatReuseSummary(document) {
  const total = Number(document.total_reuse_count || 0);
  const linked = Number(document.linked_reuse_count || 0);
  if (total <= 0) return '재사용 이력 없음';
  return `재사용 ${total}회 · 연결 ${linked}건`;
}

function QualityBadge({ summary }) {
  const status = String(summary?.status || 'good');
  const label = summary?.label || '재사용 양호';
  const map = {
    good: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    watch: 'border-amber-200 bg-amber-50 text-amber-700',
    needs_review: 'border-rose-200 bg-rose-50 text-rose-700',
  };
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${map[status] || map.good}`}>
      {label}
    </span>
  );
}

function EfficiencyBadge({ summary }) {
  const status = String(summary?.status || 'watch');
  const label = summary?.label || '효율 보통';
  const map = {
    strong: 'border-sky-200 bg-sky-50 text-sky-700',
    watch: 'border-slate-200 bg-slate-100 text-slate-700',
    improve: 'border-rose-200 bg-rose-50 text-rose-700',
  };
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${map[status] || map.watch}`}>
      {label} {summary?.score != null ? `${summary.score}점` : ''}
    </span>
  );
}

export default function DocumentsPage() {
  const [documents, setDocuments] = useState([]);
  const [qualityFilter, setQualityFilter] = useState('all');
  const [sort, setSort] = useState('recent');

  useEffect(() => {
    const params = new URLSearchParams({
      limit: '20',
      quality_status: qualityFilter,
      sort,
    });
    api.get(`/documents?${params.toString()}`)
      .then((data) => setDocuments(data.documents || []))
      .catch(() => setDocuments([]));
  }, [qualityFilter, sort]);

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
          href="/work-journals"
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

      <div className="card space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">최근 문서</p>
            <p className="mt-1 text-sm text-slate-500">최근 업로드한 문서를 열어 파싱 결과, 재사용 전환율, 품질 신호를 함께 확인합니다.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <select
              value={qualityFilter}
              onChange={(event) => setQualityFilter(event.target.value)}
              className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
            >
              <option value="all">전체 품질</option>
              <option value="needs_review">검토 필요</option>
              <option value="watch">재사용 주의</option>
              <option value="good">재사용 양호</option>
            </select>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value)}
              className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
            >
              <option value="recent">최신순</option>
              <option value="quality">품질 검토 우선</option>
              <option value="efficiency">효율 높은 순</option>
              <option value="conversion">전환율 높은 순</option>
              <option value="reuse">재사용 많은 순</option>
              <option value="linked">연결 많은 순</option>
            </select>
          </div>
        </div>
        {documents.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
            아직 업로드된 문서가 없습니다.
          </div>
        ) : (
          <div className="grid gap-3">
            {documents.map((document) => (
              <Link
                key={document.id}
                href={`/documents/${document.id}`}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-4 transition hover:border-slate-300 hover:shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="rounded-xl bg-slate-100 p-2 text-slate-700">
                        <FileText className="h-4 w-4" />
                      </div>
                      <p className="truncate text-sm font-semibold text-slate-900">{document.filename}</p>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      {document.category || '기타'} · {document.created_at || '-'}
                    </p>
                    <p className="mt-2 text-xs font-medium text-sky-700">
                      {formatReuseSummary(document)}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <QualityBadge summary={document.quality_summary} />
                      <EfficiencyBadge summary={document.efficiency_summary} />
                      {document.quality_summary?.reasons?.[0] ? (
                        <p className="text-xs text-slate-500">{document.quality_summary.reasons[0]}</p>
                      ) : null}
                    </div>
                    {document.ai_summary ? (
                      <p className="mt-2 line-clamp-2 text-sm text-slate-600">{document.ai_summary}</p>
                    ) : null}
                  </div>
                  <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-slate-400" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
