'use client';
import { useState, useEffect, useMemo, useRef } from 'react';
import { api } from '@/lib/api';
import { getToken, useAuth } from '@/lib/auth-context';
import { canPerformMenuOperation } from '@/lib/menu-access';
import PendingReviewSection from '@/components/PendingReviewSection';
import ProposalFlowActions from '@/components/ProposalFlowActions';

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
    <div className="card">
      <div className="grid grid-cols-7 mb-2">
        {WEEKDAYS.map((d, i) => (
          <div key={i} className={`text-xs text-center font-medium py-1 ${i === 0 ? 'text-red-500' : i === 6 ? 'text-blue-500' : 'text-gray-500'}`}>{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px bg-gray-100">
        {cells.map((d, i) => {
          if (!d) return <div key={`e-${i}`} className="bg-white min-h-[72px]" />;
          const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
          const dayEvts = byDate[dateStr] || [];
          const isToday = dateStr === todayStr;
          const dow = (firstDay + d - 1) % 7;
          return (
            <div key={dateStr} className="bg-white min-h-[72px] p-1">
              <div className={`text-xs font-medium mb-1 w-6 h-6 flex items-center justify-center rounded-full ${
                isToday ? 'bg-indigo-600 text-white' : dow === 0 ? 'text-red-500' : dow === 6 ? 'text-blue-500' : 'text-gray-700'
              }`}>{d}</div>
              <div className="space-y-0.5">
                {dayEvts.slice(0, 3).map(s => {
                  const cfg = TYPE_CONFIG[s.type] || {};
                  return (
                    <div key={s.id} className={`text-xs px-1 py-0.5 rounded truncate ${cfg.color || 'bg-gray-100 text-gray-600'}`}>
                      {fmtTime(s.start_time)} {s.title}
                    </div>
                  );
                })}
                {dayEvts.length > 3 && <div className="text-xs text-gray-400 px-1">+{dayEvts.length - 3}건</div>}
              </div>
            </div>
          );
        })}
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
    <div className="card space-y-2">
      {schedules.map(s => {
        const cfg = TYPE_CONFIG[s.type] || {};
        return (
          <div key={s.id} className="flex items-start gap-3 p-3 rounded-lg border border-gray-100 hover:border-indigo-200 transition-colors group">
            <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${cfg.dot || 'bg-gray-400'}`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-xs px-1.5 py-0.5 rounded ${cfg.color || 'bg-gray-100'}`}>{cfg.label || s.type}</span>
                <p className="text-sm font-medium text-gray-900">{s.title}</p>
              </div>
              <p className="text-xs text-gray-500 mt-0.5">{fmtDatetime(s.start_time)}{s.location ? ` · ${s.location}` : ''}</p>
            </div>
            {canDelete && (
              <button
                className="text-xs text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                onClick={() => onDelete(s.id)}
              >✕</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── 일정 추가 모달 ────────────────────────────────────────────────

function AddModal({ onClose, onAdded }) {
  const [form, setForm] = useState({
    title: '',
    type: 'task',
    start_time: new Date().toISOString().slice(0, 16),
    location: '',
  });
  const [saving, setSaving] = useState(false);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    setSaving(true);
    try {
      await api.post('/schedules', {
        ...form,
        start_time: new Date(form.start_time).toISOString(),
      });
      onAdded();
      onClose();
    } catch (e) { alert(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
        <h3 className="font-bold text-gray-900 mb-4">📅 일정 추가</h3>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">유형</label>
            <select className="input-base w-full" value={form.type} onChange={e => set('type', e.target.value)}>
              {Object.entries(TYPE_CONFIG).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">제목</label>
            <input className="input-base w-full" value={form.title} onChange={e => set('title', e.target.value)} placeholder="일정 제목" autoFocus />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">시작 일시</label>
            <input type="datetime-local" className="input-base w-full" value={form.start_time} onChange={e => set('start_time', e.target.value)} />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">장소 (선택)</label>
            <input className="input-base w-full" value={form.location} onChange={e => set('location', e.target.value)} placeholder="장소" />
          </div>
          <div className="flex gap-2 pt-2">
            <button type="button" className="btn-secondary flex-1" onClick={onClose}>취소</button>
            <button type="submit" className="btn-primary flex-1" disabled={saving || !form.title.trim()}>
              {saving ? '저장 중...' : '저장'}
            </button>
          </div>
        </form>
      </div>
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
  const [showAdd,   setShowAdd]   = useState(false);
  const [prompt, setPrompt] = useState('');
  const [proposal, setProposal] = useState(null);
  const [originalProposal, setOriginalProposal] = useState(null);
  const [proposalLoading, setProposalLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [uploading, setUploading] = useState(false);
  const [attachedFileName, setAttachedFileName] = useState('');

  const refillPrompt = (text) => {
    setPrompt(text);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const fileRef = useRef(null);

  const yearMonth = `${year}-${String(month + 1).padStart(2, '0')}`;

  const load = () => {
    setLoading(true);
    api.get(`/schedules?year_month=${yearMonth}`)
      .then(d => setSchedules(d.schedules || []))
      .catch(() => setSchedules([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [yearMonth]);

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
      await api.post(`/schedules/proposals/${proposal.feedback_session_id}/confirm`, { proposal });
      setNotice('일정 제안을 확정했습니다.');
      setProposal(null);
      setOriginalProposal(null);
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
      const summary = data.document?.ai_summary ? `\n참고 요약: ${data.document.ai_summary}` : '';
      setAttachedFileName(filename);
      setPrompt((prev) => `${prev ? `${prev}\n\n` : ''}[첨부 파일: ${filename}]${summary}`.trim());
      setNotice(`"${filename}" 파일을 프롬프트에 첨부했습니다.`);
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
  const canCreateSchedules = canPerformMenuOperation(user, 'schedules', 'create');
  const canDeleteSchedules = canPerformMenuOperation(user, 'schedules', 'delete');

  return (
    <div className="space-y-4">
      <div className="card space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-slate-500">일정 자연어 입력</p>
            <p className="text-sm text-slate-600 mt-1">
              예: `내일 오전 10시 업체 미팅 잡아줘`, `오늘 오후 3시 리마인더 추가해줘`
            </p>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
            확인 결과 창 기반 피드백 수집
          </span>
        </div>

        <div className="flex flex-wrap gap-2">
          {['오늘 오후 3시 팀 회의 잡아줘', '내일 오전 10시 업체 미팅 잡아줘', '모레 오후 1시 리마인더 추가해줘'].map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setPrompt(item)}
              className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              {item}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <textarea
            className="input-base min-h-[92px]"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="일정이나 미팅 요청을 자연어로 입력하세요."
          />
          {attachedFileName && (
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700">
                첨부됨: {attachedFileName}
              </span>
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            <input ref={fileRef} type="file" className="hidden" onChange={handleUpload} />
            <button
              type="button"
              className="btn-primary"
              onClick={handlePromptSubmit}
              disabled={!canCreateSchedules || proposalLoading || !prompt.trim()}
            >
              {proposalLoading ? '제안 생성 중...' : '일정 제안 만들기'}
            </button>
            <button className="btn-secondary" type="button" onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? '업로드 중...' : '파일 첨부'}
            </button>
            <button className="btn-secondary" type="button" onClick={() => setShowAdd(true)} disabled={!canCreateSchedules}>
              직접 입력 모달 열기
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            {notice}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">📅 일정 관리</h1>
        <button className="btn-primary text-sm" onClick={() => setShowAdd(true)} disabled={!canCreateSchedules}>+ 일정 추가</button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="card">
          <p className="text-sm font-medium text-slate-500">월간 일정 요약</p>
          <div className="grid gap-3 sm:grid-cols-3 mt-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <p className="text-xs text-slate-500">전체 일정</p>
              <p className="text-2xl font-semibold text-slate-900 mt-1">{schedules.length}건</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <p className="text-xs text-slate-500">예정 일정</p>
              <p className="text-2xl font-semibold text-slate-900 mt-1">{upcomingCount}건</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <p className="text-xs text-slate-500">미팅</p>
              <p className="text-2xl font-semibold text-slate-900 mt-1">{meetingCount}건</p>
            </div>
          </div>
        </div>

        <div className="card">
          <p className="text-sm font-medium text-slate-500">현재 보기</p>
          <div className="flex items-center gap-3 mt-4">
            <button className="btn-secondary px-2 py-1 text-sm" onClick={prevMonth}>‹</button>
            <span className="font-semibold text-slate-800 min-w-[92px] text-center">{year}년 {month + 1}월</span>
            <button className="btn-secondary px-2 py-1 text-sm" onClick={nextMonth}>›</button>
            <div className="ml-auto flex gap-1 bg-slate-100 p-1 rounded-2xl">
              {[{ k: 'calendar', label: '캘린더' }, { k: 'list', label: '목록' }].map(v => (
                <button
                  key={v.k}
                  className={`px-3 py-1.5 text-xs rounded-2xl font-medium transition-colors ${
                    view === v.k ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'
                  }`}
                  onClick={() => setView(v.k)}
                >
                  {v.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 월 내비 + 뷰 전환 */}
      <div className="hidden">
        <button className="btn-secondary px-2 py-1 text-sm" onClick={prevMonth}>‹</button>
        <span className="font-semibold text-gray-800 min-w-[80px] text-center">{year}년 {month + 1}월</span>
        <button className="btn-secondary px-2 py-1 text-sm" onClick={nextMonth}>›</button>
        <div className="ml-auto flex gap-1 bg-gray-100 p-1 rounded-lg">
          {[{ k: 'calendar', label: '캘린더' }, { k: 'list', label: '목록' }].map(v => (
            <button
              key={v.k}
              className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
                view === v.k ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'
              }`}
              onClick={() => setView(v.k)}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="text-center py-16 text-gray-400">로딩 중...</div>
      ) : view === 'calendar' ? (
        <CalendarView year={year} month={month} schedules={schedules} />
      ) : (
        <ListView schedules={sorted} onDelete={deleteSchedule} canDelete={canDeleteSchedules} />
      )}

      {(proposal || notice) && (
        <PendingReviewSection
          hasPending={Boolean(proposal)}
          description="일정 제안을 아래 리스트에서 검토하고 확정하거나 반려합니다."
        >
          {proposal && (
            <div className="rounded-2xl border border-sky-200 bg-sky-50/40 px-4 py-4 space-y-4">
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
                        <button
                          type="button"
                          className="mt-3 rounded-full border border-violet-200 bg-violet-100 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-200"
                          onClick={() => refillPrompt(`이 사례를 참고해서 일정 등록 제안을 다시 정리해줘\n${item.preview || item.summary || ''}`.trim())}
                        >
                          이 사례로 다시 작성
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap gap-3">
                <ProposalFlowActions
                  onPromptFill={() => refillPrompt(`일정 등록 제안을 다시 정리해줘\n제목: ${proposal.title || ''}\n시작: ${proposal.start_time || ''}\n장소: ${proposal.location || ''}`.trim())}
                  onJumpToInput={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
                />
                <button type="button" className="btn-primary" onClick={handleConfirmProposal} disabled={proposalLoading}>
                  {proposalLoading ? '확정 중...' : '이대로 확정'}
                </button>
                <button type="button" className="btn-secondary" onClick={handleRejectProposal} disabled={proposalLoading}>
                  제안 반려
                </button>
                <button type="button" className="btn-secondary" onClick={() => { setProposal(null); setOriginalProposal(null); setError(''); }} disabled={proposalLoading}>
                  닫기
                </button>
              </div>
            </div>
          )}
        </PendingReviewSection>
      )}

      {showAdd && canCreateSchedules && <AddModal onClose={() => setShowAdd(false)} onAdded={load} />}
    </div>
  );
}
