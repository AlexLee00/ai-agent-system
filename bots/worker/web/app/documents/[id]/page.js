'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useParams } from 'next/navigation';
import { Download, Files, MessageSquareShare } from 'lucide-react';
import { api } from '@/lib/api';
import { buildDocumentReusePackage } from '@/lib/document-attachment';
import { saveDocumentReuseDraft } from '@/lib/document-reuse-draft';

function MetadataCard({ label, value, caption }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-slate-900 break-all">{value || '-'}</p>
      {caption ? <p className="mt-1 text-[11px] text-slate-500">{caption}</p> : null}
    </div>
  );
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

function getLinkedEntityInfo(event) {
  const type = String(event?.linked_entity_type || '');
  const entityId = event?.linked_entity_id;
  if (!type || !entityId) return null;
  if (type === 'projects') {
    return {
      label: `프로젝트 #${entityId}`,
      href: `/projects/${entityId}`,
    };
  }
  if (type === 'journals') {
    return {
      label: `업무일지 #${entityId}`,
      href: `/journals/${entityId}`,
    };
  }
  if (type === 'sales') {
    return {
      label: `매출 #${entityId}`,
      href: '/sales',
    };
  }
  if (type === 'schedules') {
    return {
      label: `일정 #${entityId}`,
      href: '/schedules',
    };
  }
  return {
    label: `${type} #${entityId}`,
    href: null,
  };
}

export default function DocumentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [documentInfo, setDocumentInfo] = useState(null);
  const [extraction, setExtraction] = useState(null);
  const [reuseEvents, setReuseEvents] = useState([]);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError('');
    Promise.all([
      api.get(`/documents/${id}`),
      api.get(`/documents/${id}/extraction`),
      api.get(`/documents/${id}/reuse-events`).catch(() => ({ events: [] })),
    ])
      .then(([detailData, extractionData, reuseData]) => {
        setDocumentInfo(detailData.document || null);
        setExtraction(extractionData.document || null);
        setReuseEvents(reuseData.events || []);
      })
      .catch((err) => setError(err.message || '문서 정보를 불러오지 못했습니다.'))
      .finally(() => setLoading(false));
  }, [id]);

  const metadata = extraction?.extraction_metadata || documentInfo?.extraction_metadata || {};
  const qualitySummary = extraction?.quality_summary || documentInfo?.quality_summary || null;
  const efficiencySummary = documentInfo?.efficiency_summary || extraction?.efficiency_summary || null;
  const reusePackage = useMemo(() => {
    if (!documentInfo && !extraction) return null;
    return buildDocumentReusePackage({
      filename: documentInfo?.filename || extraction?.filename || '',
      extracted_text: extraction?.extracted_text || '',
      extracted_text_preview: extraction?.extracted_text_preview || documentInfo?.extracted_text_preview || '',
      extraction_metadata: metadata,
      ai_summary: documentInfo?.ai_summary || '',
    });
  }, [documentInfo, extraction, metadata]);
  const reuseSummary = useMemo(() => {
    const total = reuseEvents.length;
    const linked = reuseEvents.filter((event) => event.linked_entity_type && event.linked_entity_id).length;
    const pending = Math.max(0, total - linked);
    const reviewed = reuseEvents.filter((event) => event.feedback_session_id).length;
    const acceptedWithoutEdit = reuseEvents.filter((event) => event.accepted_without_edit).length;
    const editedSessions = reuseEvents.filter((event) => Number(event.edit_count || 0) > 0).length;
    const totalEditCount = reuseEvents.reduce((sum, event) => sum + Number(event.edit_count || 0), 0);
    const byTarget = reuseEvents.reduce((acc, event) => {
      const key = event.target_menu || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const topTargetEntry = Object.entries(byTarget).sort((a, b) => b[1] - a[1])[0] || null;
    const conversionRate = total > 0 ? Math.round((linked / total) * 100) : 0;
    const acceptedWithoutEditRate = reviewed > 0 ? Math.round((acceptedWithoutEdit / reviewed) * 100) : 0;
    const avgEditCount = reviewed > 0 ? (totalEditCount / reviewed).toFixed(1) : '0.0';
    return {
      total,
      linked,
      pending,
      reviewed,
      acceptedWithoutEdit,
      editedSessions,
      acceptedWithoutEditRate,
      avgEditCount,
      conversionRate,
      topTarget: topTargetEntry ? `${topTargetEntry[0]} (${topTargetEntry[1]}건)` : '-',
    };
  }, [reuseEvents]);

  async function copyReusePrompt() {
    if (!reusePackage?.appendix) return;
    try {
      await navigator.clipboard.writeText(reusePackage.appendix);
      setNotice(`"${reusePackage.filename}" 재사용 프롬프트를 복사했습니다.`);
    } catch {
      setError('재사용 프롬프트를 복사하지 못했습니다.');
    }
  }

  async function handoffTo(target, href) {
    if (!reusePackage?.appendix) return;
    let draftPayload = {
      draft: reusePackage.appendix,
      documentId: Number(id),
      filename: reusePackage.filename,
      category: documentInfo?.category || '',
    };
    const ok = saveDocumentReuseDraft(target, draftPayload);
    if (!ok) {
      setError('문서 초안을 임시 저장하지 못했습니다.');
      return;
    }
    try {
      const data = await api.post(`/documents/${id}/reuse-events`, {
        target_menu: target,
        prompt_length: reusePackage.appendix.length,
      });
      if (data?.event) {
        setReuseEvents((prev) => [data.event, ...prev].slice(0, 20));
        draftPayload = { ...draftPayload, reuseEventId: data.event.id };
        saveDocumentReuseDraft(target, draftPayload);
      }
    } catch {
      // 이력 저장 실패는 화면 이동을 막지 않음
    }
    router.push(href);
  }

  if (loading) {
    return <div className="py-16 text-center text-sm text-slate-500">문서 정보를 불러오는 중...</div>;
  }

  if (error) {
    return <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>;
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Link href="/documents" className="hover:text-slate-700">문서</Link>
          <span>/</span>
          <span>상세</span>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900">{documentInfo?.filename || extraction?.filename || '문서 상세'}</h1>
            <p className="mt-1 text-sm text-slate-500">
              파싱 결과를 확인하고, 업무 프롬프트에 다시 붙일 수 있는 재사용 패키지를 바로 확인합니다.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {documentInfo?.download_url ? (
              <a href={documentInfo.download_url} className="btn-secondary text-sm gap-2">
                <Download className="w-4 h-4" />
                파일 다운로드
              </a>
            ) : null}
            {reusePackage?.appendix ? (
              <button type="button" className="btn-primary text-sm gap-2" onClick={copyReusePrompt}>
                <MessageSquareShare className="w-4 h-4" />
                재사용 프롬프트 복사
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {notice ? <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div> : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="space-y-6">
          <div className="card space-y-4">
            <div>
              <p className="text-sm font-semibold text-slate-900">문서 개요</p>
              <p className="mt-1 text-sm text-slate-500">문서 분류, 생성 시각, 추출 상태를 한 번에 확인합니다.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <MetadataCard label="분류" value={documentInfo?.category || '-'} />
              <MetadataCard label="추출 방식" value={metadata.extractionMethod || '-'} />
              <MetadataCard label="문서 유형" value={metadata.sourceFileType || '-'} />
              <MetadataCard label="텍스트 길이" value={metadata.analysisReadyTextLength ?? 0} caption="analysis ready chars" />
              <MetadataCard label="생성 시각" value={documentInfo?.created_at || '-'} />
              <MetadataCard label="파싱 시각" value={extraction?.extracted_at || documentInfo?.extracted_at || '-'} />
            </div>
            <div className="rounded-3xl border border-slate-200 bg-slate-50 px-4 py-4">
              <p className="text-xs font-medium text-slate-500">AI 요약</p>
              <p className="mt-2 whitespace-pre-wrap text-sm text-slate-800">{documentInfo?.ai_summary || '저장된 요약이 없습니다.'}</p>
            </div>
          </div>

          <div className="card space-y-4">
            <div>
              <p className="text-sm font-semibold text-slate-900">문서 재사용 성과</p>
              <p className="mt-1 text-sm text-slate-500">이 문서가 실제 업무 생성으로 얼마나 이어졌는지 빠르게 확인합니다.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <MetadataCard label="재사용 횟수" value={reuseSummary.total} caption="전달된 업무 화면 기준" />
              <MetadataCard label="실제 연결 수" value={reuseSummary.linked} caption="확정 후 생성 결과 연결" />
              <MetadataCard label="미확정 건수" value={reuseSummary.pending} caption="아직 확정되지 않은 재사용" />
              <MetadataCard label="전환율" value={`${reuseSummary.conversionRate}%`} caption="linked / total" />
              <MetadataCard label="가장 많이 보낸 곳" value={reuseSummary.topTarget} />
            </div>
          </div>

          <div className="card space-y-4">
            <div>
              <p className="text-sm font-semibold text-slate-900">문서 재사용 효율</p>
              <p className="mt-1 text-sm text-slate-500">AI 확인창 이후 얼마나 수정 없이 확정됐는지 함께 봅니다.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <MetadataCard label="AI 확인 세션" value={reuseSummary.reviewed} caption="feedback_session_id 연결 기준" />
              <MetadataCard label="무수정 확정" value={reuseSummary.acceptedWithoutEdit} caption="accepted_without_edit" />
              <MetadataCard label="무수정 확정률" value={`${reuseSummary.acceptedWithoutEditRate}%`} caption="accepted_without_edit / reviewed" />
              <MetadataCard label="수정 발생 세션" value={reuseSummary.editedSessions} caption="edit_count > 0" />
              <MetadataCard label="평균 수정 필드 수" value={reuseSummary.avgEditCount} caption="reviewed 세션 평균" />
              <MetadataCard label="종합 효율 점수" value={efficiencySummary?.score != null ? `${efficiencySummary.score}점` : '-'} caption="품질 · 전환율 · 무수정 확정률 기반" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <EfficiencyBadge summary={efficiencySummary} />
              {efficiencySummary?.reasons?.map((reason) => (
                <span key={reason} className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-medium text-slate-600">
                  {reason}
                </span>
              ))}
            </div>
          </div>

          <div className="card space-y-4">
            <div>
              <p className="text-sm font-semibold text-slate-900">문서 품질 신호</p>
              <p className="mt-1 text-sm text-slate-500">재사용 전에 원문 확인이 필요한 문서를 빠르게 구분합니다.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <QualityBadge summary={qualitySummary} />
              {qualitySummary?.sourceFileType ? (
                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-medium text-slate-600">
                  유형 {qualitySummary.sourceFileType}
                </span>
              ) : null}
              {qualitySummary?.textLength >= 0 ? (
                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-medium text-slate-600">
                  텍스트 {qualitySummary.textLength}자
                </span>
              ) : null}
            </div>
            {qualitySummary?.reasons?.length ? (
              <div className="space-y-2">
                {qualitySummary.reasons.map((reason) => (
                  <div
                    key={reason}
                    className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700"
                  >
                    {reason}
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                현재 메타데이터 기준으로는 재사용 전 추가 확인이 필요한 품질 경고가 없습니다.
              </div>
            )}
          </div>

          <div className="card space-y-4">
            <div className="flex items-center gap-2">
              <Files className="h-4 w-4 text-slate-500" />
              <div>
                <p className="text-sm font-semibold text-slate-900">업무 재사용 패키지</p>
                <p className="mt-1 text-sm text-slate-500">다른 업무 화면의 프롬프트에 바로 붙일 수 있는 형태입니다.</p>
              </div>
            </div>
            {reusePackage?.hints?.length ? (
              <div className="flex flex-wrap gap-2">
                {reusePackage.hints.map((hint) => (
                  <span key={hint} className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-medium text-slate-600">
                    {hint}
                  </span>
                ))}
              </div>
            ) : null}
            <pre className="max-h-[24rem] overflow-auto whitespace-pre-wrap break-words rounded-2xl border border-slate-200 bg-slate-950 px-4 py-4 text-xs leading-6 text-slate-100">
              {reusePackage?.appendix || '재사용 가능한 문서 패키지가 없습니다.'}
            </pre>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-secondary text-sm" onClick={() => handoffTo('dashboard', '/dashboard')}>
                대시보드로 보내기
              </button>
              <button type="button" className="btn-secondary text-sm" onClick={() => handoffTo('schedules', '/schedules')}>
                일정으로 보내기
              </button>
              <button type="button" className="btn-secondary text-sm" onClick={() => handoffTo('journals', '/journals')}>
                업무로 보내기
              </button>
              <button type="button" className="btn-secondary text-sm" onClick={() => handoffTo('sales', '/sales')}>
                매출로 보내기
              </button>
              <button type="button" className="btn-secondary text-sm" onClick={() => handoffTo('projects', '/projects')}>
                프로젝트로 보내기
              </button>
            </div>
          </div>

          <div className="card space-y-4">
            <div>
              <p className="text-sm font-semibold text-slate-900">문서 재사용 이력</p>
              <p className="mt-1 text-sm text-slate-500">이 문서가 어떤 업무 화면으로 다시 전달됐는지 기록합니다.</p>
            </div>
            {reuseEvents.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500">
                아직 저장된 재사용 이력이 없습니다.
              </div>
            ) : (
              <div className="space-y-2">
                {reuseEvents.map((event) => (
                  <div key={event.id} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <p className="text-sm font-semibold text-slate-900">{event.target_menu}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {event.created_at} · {event.reused_by_name || event.reused_by || '알 수 없음'} · {event.prompt_length || 0}자
                    </p>
                    {(() => {
                      const linked = getLinkedEntityInfo(event);
                      if (!linked) return null;
                      return (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <p className="text-xs font-medium text-emerald-700">
                            연결 완료 · {linked.label}
                          </p>
                          {linked.href ? (
                            <Link href={linked.href} className="text-xs font-medium text-sky-700 hover:text-sky-900">
                              결과 보기
                            </Link>
                          ) : null}
                        </div>
                      );
                    })()}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="card space-y-4">
          <div>
            <p className="text-sm font-semibold text-slate-900">파싱 결과 텍스트</p>
            <p className="mt-1 text-sm text-slate-500">업무 재사용 전 실제 추출된 텍스트를 그대로 확인합니다.</p>
          </div>
          <pre className="max-h-[56rem] overflow-auto whitespace-pre-wrap break-words rounded-3xl border border-slate-200 bg-slate-950 px-4 py-4 text-xs leading-6 text-slate-100">
            {extraction?.extracted_text || '파싱된 텍스트가 없습니다.'}
          </pre>
        </div>
      </div>
    </div>
  );
}
