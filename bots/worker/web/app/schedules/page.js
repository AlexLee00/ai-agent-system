'use client';
import { useState, useEffect, useMemo, useRef } from 'react';
import { api } from '@/lib/api';
import { getToken, useAuth } from '@/lib/auth-context';
import { canPerformMenuOperation } from '@/lib/menu-access';
import AdminQuickNav from '@/components/AdminQuickNav';
import AdminPageHero from '@/components/AdminPageHero';
import PendingReviewSection from '@/components/PendingReviewSection';
import PromptAdvisor from '@/components/PromptAdvisor';
import OperationsSectionHeader from '@/components/OperationsSectionHeader';
import { buildDocumentPromptAppendix, buildDocumentUploadNotice } from '@/lib/document-attachment';
import { consumeDocumentReuseDraft } from '@/lib/document-reuse-draft';
import useAutoResizeTextarea from '@/lib/useAutoResizeTextarea';

const TYPE_CONFIG = {
  meeting:  { label: '미팅',     color: 'bg-blue-100 text-blue-700',   dot: 'bg-blue-500' },
  task:     { label: '업무',     color: 'bg-indigo-100 text-indigo-700', dot: 'bg-indigo-500' },
  event:    { label: '이벤트',   color: 'bg-pink-100 text-pink-700',   dot: 'bg-pink-500' },
  reminder: { label: '리마인더', color: 'bg-yellow-100 text-yellow-700', dot: 'bg-yellow-500' },
};

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtDatetime(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

function toDateTimeLocal(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromDateTimeLocal(value) {
  if (!value) return null;
  return new Date(value).toISOString();
}

function proposalChanged(original, proposal) {
  if (!original || !proposal) return false;
  return ['title', 'type', 'start_time', 'location', 'description'].some((key) => (original[key] || '') !== (proposal[key] || ''));
}

// ── 캘린더 뷰 ──────────────────────────────────────────────────────

function CalendarView({ year, month, schedules }) {
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

  // 날짜별 일정 맵
  const byDate = useMemo(() => {
    const m = {};
    for (const s of schedules) {
      if (!s.start_time) continue;
      const d = s.start_time.slice(0, 10);
      if (!m[d]) m[d] = [];
      m[d].push(s);
    }
    return m;
  }, [schedules]);

  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[700px]">
        <div className="mb-2 grid grid-cols-7">
          {WEEKDAYS.map((d, i) => (
            <div key={i} className={`py-1 text-center text-xs font-medium ${i === 0 ? 'text-red-500' : i === 6 ? 'text-blue-500' : 'text-gray-500'}`}>{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-2">
          {cells.map((d, i) => {
            if (!d) return <div key={`e-${i}`} className="min-h-[88px] rounded-2xl border border-dashed border-slate-200 bg-slate-50/60" />;
            const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
            const dayEvts = byDate[dateStr] || [];
            const isToday = dateStr === todayStr;
            const dow = (firstDay + d - 1) % 7;
            return (
              <div key={dateStr} className="min-h-[88px] rounded-2xl border border-slate-200 bg-white p-2">
                <div className={`mb-1 flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                  isToday ? 'bg-indigo-600 text-white' : dow === 0 ? 'text-red-500' : dow === 6 ? 'text-blue-500' : 'text-gray-700'
                }`}>{d}</div>
                <div className="space-y-1">
                  {dayEvts.slice(0, 3).map(s => {
                    const cfg = TYPE_CONFIG[s.type] || {};
                    return (
                      <div key={s.id} className={`truncate rounded px-1 py-0.5 text-xs ${cfg.color || 'bg-gray-100 text-gray-600'}`}>
                        {fmtTime(s.start_time)} {s.title}
                      </div>
                    );
                  })}
                  {dayEvts.length > 3 && <div className="px-1 text-xs text-gray-400">+{dayEvts.length - 3}건</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── 리스트 뷰 ─────────────────────────────────────────────────────

function ListView({ schedules, onDelete, canDelete }) {
  if (!schedules.length) return (
    <div className="text-center py-16 text-gray-400">
      <p className="text-4xl mb-3">📅</p>
      <p className="text-sm">이달 일정 없음</p>
    </div>
  );

  return (
    <div className="space-y-2">
      {schedules.map(s => {
        const cfg = TYPE_CONFIG[s.type] || {};
        return (
          <div key={s.id} className="group flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 transition-colors hover:border-indigo-200">
            <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${cfg.dot || 'bg-gray-400'}`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-xs px-1.5 py-0.5 rounded ${cfg.color || 'bg-gray-100'}`}>{cfg.label || s.type}</span>
                <p className="text-sm font-medium text-slate-900">{s.title}</p>
              </div>
              <p className="mt-1 text-xs text-slate-500">{fmtDatetime(s.start_time)}{s.location ? ` · ${s.location}` : ''}</p>
            </div>
            {canDelete && (
              <button
                className="shrink-0 text-xs text-slate-300 opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-500"
                onClick={() => onDelete(s.id)}
              >✕</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── 메인 페이지 ───────────────────────────────────────────────────

export default function SchedulesPage() {
  const { user } = useAuth();
  const now = new Date();
  const [year,  setYear]  = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth()); // 0-based
  const [view,  setView]  = useState('calendar'); // 'calendar' | 'list'
  const [schedules, setSchedules] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [prompt, setPrompt] = useState('');
  const [proposal, setProposal] = useState(null);
  const [originalProposal, setOriginalProposal] = useState(null);
  const [proposalLoading, setProposalLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [uploading, setUploading] = useState(false);
  const [attachedFileName, setAttachedFileName] = useState('');
  const [reusedDocument, setReusedDocument] = useState(null);

  const fileRef = useRef(null);
  const promptRef = useRef(null);
  useAutoResizeTextarea(promptRef, prompt);

  const yearMonth = `${year}-${String(month + 1).padStart(2, '0')}`;

  const load = () => {
    setLoading(true);
    api.get(`/schedules?year_month=${yearMonth}`)
      .then(d => setSchedules(d.schedules || []))
      .catch(() => setSchedules([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [yearMonth]);
  useEffect(() => {
    const reusedDraft = consumeDocumentReuseDraft('schedules');
    if (reusedDraft?.draft) {
      setPrompt(reusedDraft.draft);
      setReusedDocument(reusedDraft);
    }
  }, []);

  const prevMonth = () => {
    if (month === 0) { setYear(y => y - 1); setMonth(11); }
    else setMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (month === 11) { setYear(y => y + 1); setMonth(0); }
    else setMonth(m => m + 1);
  };

  const createProposal = async (payload) => {
    setProposalLoading(true);
    setError('');
    setNotice('');
    try {
      const data = await api.post('/schedules/proposals', payload);
      setProposal(data.proposal || null);
      setOriginalProposal(data.proposal || null);
      if (payload.prompt) setPrompt('');
    } catch (e) {
      setError(e.message);
    } finally {
      setProposalLoading(false);
    }
  };

  const handlePromptSubmit = async () => {
    if (!prompt.trim()) return;
    await createProposal({ prompt });
  };

  const handleConfirmProposal = async () => {
    if (!proposal?.feedback_session_id) return;
    setProposalLoading(true);
    setError('');
    try {
      await api.post(`/schedules/proposals/${proposal.feedback_session_id}/confirm`, {
        proposal,
        reuse_event_id: reusedDocument?.reuseEventId || null,
      });
      setNotice('일정 제안을 확정했습니다.');
      setProposal(null);
      setOriginalProposal(null);
      setReusedDocument(null);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setProposalLoading(false);
    }
  };

  const handleRejectProposal = async () => {
    if (!proposal?.feedback_session_id) return;
    setProposalLoading(true);
    setError('');
    try {
      await api.post(`/schedules/proposals/${proposal.feedback_session_id}/reject`, {});
      setNotice('일정 제안을 반려했습니다.');
      setProposal(null);
      setOriginalProposal(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setProposalLoading(false);
    }
  };

  const handleUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    setUploading(true);
    setError('');
    try {
      const token = getToken();
      const res = await fetch('/api/documents/upload', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '파일 업로드 실패');
      const filename = data.document?.filename || file.name;
      const appendix = buildDocumentPromptAppendix(data.document, file.name);
      setAttachedFileName(filename);
      setPrompt((prev) => `${prev ? `${prev}\n\n` : ''}${appendix}`.trim());
      setNotice(buildDocumentUploadNotice(data.document, file.name));
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const deleteSchedule = async (scheduleId) => {
    if (!confirm('일정을 삭제하시겠습니까?')) return;
    try {
      await api.delete(`/schedules/${scheduleId}`);
      load();
    } catch (e) { alert(e.message); }
  };

  // 리스트뷰용 정렬
  const sorted = [...schedules].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  const upcomingCount = sorted.filter(item => new Date(item.start_time) >= new Date()).length;
  const meetingCount = schedules.filter(item => item.type === 'meeting').length;
  const reminderCount = schedules.filter(item => item.type === 'reminder').length;
  const canCreateSchedules = canPerformMenuOperation(user, 'schedules', 'create');
  const canDeleteSchedules = canPerformMenuOperation(user, 'schedules', 'delete');

  return (
    <div className="flex flex-col gap-6">
      {user?.role !== 'member' && <AdminQuickNav />}

      <AdminPageHero
        title="일정 관리"
        description="캘린더와 리스트를 오가며 일정, 미팅, 리마인더를 관리합니다."
        stats={[
          {
            label: '이달 일정',
            value: `${schedules.length || 0}건`,
            caption: `${yearMonth} 기준`,
            body: '현재 월에 등록된 전체 일정 수입니다.',
          },
          {
            label: '미팅',
            value: `${meetingCount || 0}건`,
            caption: 'type=meeting',
            body: '협업 및 고객 미팅 일정만 따로 집계합니다.',
          },
          {
            label: '리마인더',
            value: `${reminderCount || 0}건`,
            caption: 'type=reminder',
            body: '후속 확인용 리마인더 일정을 집계합니다.',
          },
        ]}
      />

      <PromptAdvisor
        title="프롬프트 어드바이저"
        description="일정 등록, 미팅 추가, 리마인더 요청을 자연어로 정리하고 바로 일정 제안 검토로 이어집니다."
        badge={`Noah 일정 ${user?.role === 'master' ? '오케스트레이터' : user?.role === 'admin' ? '운영 에이전트' : '에이전트'}`}
        suggestions={[
          '오늘 오후 3시 팀 회의 잡아줘',
          '내일 오전 10시 업체 미팅 잡아줘',
          '모레 오후 1시 리마인더 추가해줘',
        ]}
        helperText="일정 등록, 미팅 추가, 리마인더 등록처럼 일정 관리 요청을 빠르게 확인 결과로 넘길 때 적합합니다."
        prompt={prompt}
        onPromptChange={setPrompt}
        promptRef={promptRef}
        placeholder="일정이나 미팅 요청을 자연어로 입력하세요."
        onFileClick={() => fileRef.current?.click()}
        uploading={uploading}
        attachedFileName={attachedFileName}
        onReset={() => {
          setPrompt('');
          setError('');
          setNotice('');
          setAttachedFileName('');
          setReusedDocument(null);
          if (fileRef.current) fileRef.current.value = '';
        }}
        onSubmit={handlePromptSubmit}
        submitDisabled={!canCreateSchedules || proposalLoading || !prompt.trim()}
        error={error}
        notice={notice}
      />

      <input ref={fileRef} type="file" className="hidden" onChange={handleUpload} />

      {(proposal || notice) && (
        <PendingReviewSection
          hasPending={Boolean(proposal)}
          description="일정 제안을 아래 리스트에서 검토하고 확정하거나 반려합니다."
        >
          {proposal && (
            <div className="rounded-3xl border border-sky-200 bg-sky-50/40 px-5 py-5 space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-sky-700">일정 제안</p>
                  <h2 className="text-lg font-semibold text-slate-900 mt-1">{proposal.summary}</h2>
                  <p className="text-sm text-slate-600 mt-1">자연어 입력을 일정 제안으로 해석했습니다. 제목, 시간, 장소를 확인한 뒤 확정하세요.</p>
                </div>
                <div className="flex flex-col gap-2 text-right">
                  <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600 border border-slate-200">
                    {proposal.confidence === 'high' ? '해석 신뢰도 높음' : '해석 신뢰도 보통'}
                  </span>
                  <span className={`rounded-full px-3 py-1 text-xs font-semibold border ${proposalChanged(originalProposal, proposal)
                    ? 'border-amber-200 bg-amber-50 text-amber-700'
                    : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
                    {proposalChanged(originalProposal, proposal) ? '수정 있음' : '수정 없음'}
                  </span>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-1 md:col-span-2">
                  <span className="text-xs font-semibold text-slate-500">제목</span>
                  <input className="input-base" value={proposal.title || ''} onChange={(e) => setProposal((prev) => ({ ...prev, title: e.target.value, summary: `${e.target.value} · ${fmtDatetime(prev.start_time)}` }))} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-semibold text-slate-500">유형</span>
                  <select className="input-base" value={proposal.type} onChange={(e) => setProposal((prev) => ({ ...prev, type: e.target.value }))}>
                    {Object.entries(TYPE_CONFIG).map(([key, value]) => (
                      <option key={key} value={key}>{value.label}</option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-semibold text-slate-500">시작 일시</span>
                  <input
                    type="datetime-local"
                    className="input-base"
                    value={toDateTimeLocal(proposal.start_time)}
                    onChange={(e) => setProposal((prev) => ({
                      ...prev,
                      start_time: fromDateTimeLocal(e.target.value),
                      summary: `${prev.title} · ${fmtDatetime(fromDateTimeLocal(e.target.value))}`,
                    }))}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-semibold text-slate-500">장소</span>
                  <input className="input-base" value={proposal.location || ''} onChange={(e) => setProposal((prev) => ({ ...prev, location: e.target.value }))} placeholder="장소" />
                </label>
                <label className="space-y-1 md:col-span-2">
                  <span className="text-xs font-semibold text-slate-500">설명</span>
                  <textarea className="input-base min-h-[88px]" value={proposal.description || ''} onChange={(e) => setProposal((prev) => ({ ...prev, description: e.target.value }))} placeholder="필요하면 일정 설명을 남길 수 있습니다." />
                </label>
              </div>

              <div className="grid gap-4 md:grid-cols-2 md:items-stretch">
                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-700 h-full">
                  <p><span className="font-semibold text-slate-900">제안 일정</span> {proposal.title || '-'}</p>
                  <p className="mt-1"><span className="font-semibold text-slate-900">예정 시각</span> {fmtDatetime(proposal.start_time)}</p>
                  <p className="mt-1"><span className="font-semibold text-slate-900">장소</span> {proposal.location || '-'}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-700 h-full">
                  <p><span className="font-semibold text-slate-900">처리 방식</span> 수정 후 확정하면 즉시 일정에 반영됩니다.</p>
                  <p className="mt-1"><span className="font-semibold text-slate-900">설명</span> {proposal.description || '추가 설명 없음'}</p>
                </div>
              </div>

              {Array.isArray(proposal.similar_cases) && proposal.similar_cases.length > 0 && (
                <div className="rounded-2xl border border-violet-200 bg-violet-50/70 px-4 py-4">
                  <p className="text-sm font-semibold text-violet-900">유사 확정 사례</p>
                  <div className="mt-3 space-y-2">
                    {proposal.similar_cases.map((item) => (
                      <div key={item.id} className="rounded-xl border border-violet-100 bg-white/90 px-3 py-3 text-sm text-slate-700">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-medium text-slate-900">{item.summary || '유사 일정 사례'}</p>
                          <span className="rounded-full bg-violet-100 px-2 py-1 text-[11px] font-semibold text-violet-700">
                            유사도 {(item.similarity * 100).toFixed(0)}%
                          </span>
                        </div>
                        <p className="mt-2 text-xs text-slate-600 whitespace-pre-wrap">{item.preview}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap gap-3">
                <button type="button" className="btn-primary" onClick={handleConfirmProposal} disabled={proposalLoading}>
                  {proposalLoading ? '확정 중...' : '이대로 확정'}
                </button>
                <button type="button" className="btn-secondary" onClick={handleRejectProposal} disabled={proposalLoading}>
                  제안 반려
                </button>
              </div>
            </div>
          )}
        </PendingReviewSection>
      )}

      {reusedDocument ? (
        <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <p className="font-semibold">문서 재사용 초안이 적용됨</p>
          <p className="mt-1 text-sky-800">{reusedDocument.filename || '이전 문서'} 기반으로 일정 초안이 채워졌습니다.</p>
          {reusedDocument.documentId ? (
            <a href={`/documents/${reusedDocument.documentId}`} className="mt-2 inline-flex text-xs font-medium text-sky-700 hover:text-sky-900">
              문서 상세 보기
            </a>
          ) : null}
        </div>
      ) : null}

      <div className="card">
        <OperationsSectionHeader
          className="border-b border-slate-200 pb-4"
          right={(
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                onClick={prevMonth}
                aria-label="이전 달"
              >
                ‹
              </button>
              <span className="min-w-[92px] text-center font-semibold text-slate-800">{year}년 {month + 1}월</span>
              <button
                type="button"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                onClick={nextMonth}
                aria-label="다음 달"
              >
                ›
              </button>
            </div>
          )}
        />
        <div className="mt-4 flex flex-wrap gap-2">
          {[{ k: 'calendar', label: '캘린더' }, { k: 'list', label: '목록' }].map(v => (
            <button
              type="button"
              key={v.k}
              onClick={() => setView(v.k)}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                view === v.k
                  ? 'bg-slate-900 text-white'
                  : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
        <div className="mt-5 sm:mt-4">
          {loading ? (
            <div className="py-16 text-center text-gray-400">로딩 중...</div>
          ) : view === 'calendar' ? (
            <CalendarView year={year} month={month} schedules={schedules} />
          ) : (
            <ListView schedules={sorted} onDelete={deleteSchedule} canDelete={canDeleteSchedules} />
          )}
        </div>
      </div>

    </div>
  );
}
