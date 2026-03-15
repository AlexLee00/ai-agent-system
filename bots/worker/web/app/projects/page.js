'use client';
import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { getToken, useAuth } from '@/lib/auth-context';
import { canPerformMenuOperation } from '@/lib/menu-access';
import AdminQuickNav from '@/components/AdminQuickNav';
import AdminPageHero from '@/components/AdminPageHero';
import AdminQuickFlowGrid from '@/components/AdminQuickFlowGrid';
import PendingReviewSection from '@/components/PendingReviewSection';
import ProposalFlowActions from '@/components/ProposalFlowActions';

const STATUS_CONFIG = {
  planning:    { label: '기획',   color: 'bg-blue-50 text-blue-700 border-blue-200',   dot: 'bg-blue-500' },
  in_progress: { label: '진행중', color: 'bg-yellow-50 text-yellow-700 border-yellow-200', dot: 'bg-yellow-500' },
  review:      { label: '검토',   color: 'bg-orange-50 text-orange-700 border-orange-200', dot: 'bg-orange-500' },
  completed:   { label: '완료',   color: 'bg-green-50 text-green-700 border-green-200',  dot: 'bg-green-500' },
};

const TABS = [
  { key: 'active',    label: '진행 중' },
  { key: 'completed', label: '완료' },
  { key: 'all',       label: '전체' },
];

function proposalChanged(original, proposal) {
  if (!original || !proposal) return false;
  return ['name', 'description', 'status', 'start_date', 'end_date'].some((key) => String(original[key] || '') !== String(proposal[key] || ''));
}

function ProjectCard({ project }) {
  const cfg = STATUS_CONFIG[project.status] || {};
  const pct = Number(project.progress ?? 0);

  return (
    <Link href={`/projects/${project.id}`} className="card hover:shadow-md transition-shadow cursor-pointer block">
      <div className="flex items-start justify-between gap-2 mb-3">
        <h3 className="font-semibold text-gray-900 leading-snug">{project.name}</h3>
        <span className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded-full border ${cfg.color}`}>
          {cfg.label ?? project.status}
        </span>
      </div>

      {/* 진행률 바 */}
      <div className="mb-3">
        <div className="flex justify-between text-xs text-gray-500 mb-1">
          <span>진행률</span>
          <span className="font-medium">{pct}%</span>
        </div>
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${cfg.dot ?? 'bg-indigo-500'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {project.end_date && (
        <p className="text-xs text-gray-400">마감: {project.end_date.slice(0, 10)}</p>
      )}
    </Link>
  );
}

function CreateModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.post('/projects', {
        name: name.trim(),
        description: description.trim() || null,
        start_date: startDate || null,
        end_date: endDate || null,
      });
      onCreated();
      onClose();
    } catch (e) { alert(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
        <h3 className="font-bold text-gray-900 mb-4">📋 새 프로젝트</h3>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">프로젝트명</label>
            <input
              className="input-base w-full"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="프로젝트 이름"
              autoFocus
            />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">설명</label>
            <textarea
              className="input-base w-full min-h-[84px]"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="프로젝트 개요"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-sm font-medium text-gray-700 block mb-1">시작일</label>
              <input type="date" className="input-base w-full" value={startDate} onChange={e => setStartDate(e.target.value)} />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700 block mb-1">마감일</label>
              <input type="date" className="input-base w-full" value={endDate} onChange={e => setEndDate(e.target.value)} />
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            <button type="button" className="btn-secondary flex-1" onClick={onClose}>취소</button>
            <button type="submit" className="btn-primary flex-1" disabled={saving || !name.trim()}>
              {saving ? '생성 중...' : '생성'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function ProjectsPage() {
  const { user } = useAuth();
  const [projects, setProjects] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [tab,      setTab]      = useState('active');
  const [showCreate, setShowCreate] = useState(false);
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

  const load = () => {
    setLoading(true);
    api.get('/projects').then(d => setProjects(d.projects || [])).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const createProposal = async () => {
    if (!prompt.trim()) return;
    setProposalLoading(true);
    setError('');
    setNotice('');
    try {
      const data = await api.post('/projects/proposals', { prompt });
      setProposal(data.proposal || null);
      setOriginalProposal(data.proposal || null);
      setPrompt('');
    } catch (e) {
      setError(e.message);
    } finally {
      setProposalLoading(false);
    }
  };

  const handleConfirmProposal = async () => {
    if (!proposal?.feedback_session_id) return;
    setProposalLoading(true);
    setError('');
    try {
      await api.post(`/projects/proposals/${proposal.feedback_session_id}/confirm`, { proposal });
      setNotice('프로젝트 생성 제안을 확정했습니다.');
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
      await api.post(`/projects/proposals/${proposal.feedback_session_id}/reject`, {});
      setNotice('프로젝트 생성 제안을 반려했습니다.');
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

  const filtered = projects.filter(p => {
    if (tab === 'active')    return p.status !== 'completed';
    if (tab === 'completed') return p.status === 'completed';
    return true;
  });
  const activeCount = projects.filter(p => p.status !== 'completed').length;
  const completedCount = projects.filter(p => p.status === 'completed').length;
  const avgProgress = projects.length
    ? Math.round(projects.reduce((sum, item) => sum + Number(item.progress || 0), 0) / projects.length)
    : 0;
  const canCreateProjects = canPerformMenuOperation(user, 'projects', 'create');
  const quickFlows = [
    {
      title: '지연 프로젝트 점검',
      body: '마감이 임박하거나 진행이 느린 프로젝트를 바로 점검합니다.',
      onPromptFill: () => refillPrompt('지연 중이거나 마감이 임박한 프로젝트를 요약해줘'),
      onSecondary: () => setTab('active'),
      secondaryLabel: '진행 중 보기',
    },
    {
      title: '완료 프로젝트 회고',
      body: '완료된 프로젝트를 다시 보고 회고나 보고서 흐름으로 이어갑니다.',
      onPromptFill: () => refillPrompt('최근 완료된 프로젝트를 회고용으로 정리해줘'),
      onSecondary: () => setTab('completed'),
      secondaryLabel: '완료 보기',
    },
  ];

  return (
    <div className="space-y-4">
      {user?.role !== 'member' && <AdminQuickNav />}

      <AdminPageHero
        title="프로젝트 관리"
        description="프로젝트 생성, 진행률, 마감 상태와 제안 흐름을 한 화면에서 관리합니다."
        stats={[
          { label: '진행 중', value: activeCount || 0, caption: 'completed 제외' },
          { label: '완료', value: completedCount || 0, caption: 'status=completed' },
          { label: '평균 진행률', value: `${avgProgress}%`, caption: '전체 프로젝트 기준' },
        ]}
      />

      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-slate-600">프로젝트 운영 작업</p>
        <button className="btn-primary text-sm" onClick={() => setShowCreate(true)} disabled={!canCreateProjects}>+ 새 프로젝트</button>
      </div>

      {user?.role !== 'member' && <AdminQuickFlowGrid items={quickFlows} />}

      <div className="card space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-slate-500">프로젝트 자연어 생성</p>
            <p className="text-sm text-slate-600 mt-1">
              예: `신규 멤버 포털 프로젝트 만들어줘`, `4월 이벤트 랜딩 프로젝트 2026년 4월 1일 시작 4월 20일 마감으로 추가해줘`
            </p>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
            확인 결과 창 기반 피드백 수집
          </span>
        </div>

        <div className="flex flex-wrap gap-2">
          {['신규 멤버 포털 프로젝트 만들어줘', '4월 이벤트 랜딩 프로젝트 추가해줘', '사내 위키 개선 프로젝트 생성해줘'].map((item) => (
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
          <input ref={fileRef} type="file" className="hidden" onChange={handleUpload} />
          <textarea
            className="input-base min-h-[92px]"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="프로젝트 생성 요청을 자연어로 입력하세요."
          />
          {attachedFileName && (
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700">
                첨부됨: {attachedFileName}
              </span>
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            <button type="button" className="btn-primary" onClick={createProposal} disabled={!canCreateProjects || proposalLoading || !prompt.trim()}>
              {proposalLoading ? '제안 생성 중...' : '프로젝트 제안 만들기'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => fileRef.current?.click()} disabled={!canCreateProjects || uploading}>
              {uploading ? '업로드 중...' : '파일 첨부'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setShowCreate(true)} disabled={!canCreateProjects}>
              직접 입력 모달 열기
            </button>
          </div>
        </div>

        {error && <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
        {notice && <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="card">
          <p className="text-sm font-medium text-slate-500">프로젝트 운영 요약</p>
          <div className="grid gap-3 sm:grid-cols-3 mt-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <p className="text-xs text-slate-500">진행 중</p>
              <p className="text-2xl font-semibold text-slate-900 mt-1">{activeCount}건</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <p className="text-xs text-slate-500">완료</p>
              <p className="text-2xl font-semibold text-slate-900 mt-1">{completedCount}건</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <p className="text-xs text-slate-500">평균 진행률</p>
              <p className="text-2xl font-semibold text-slate-900 mt-1">{avgProgress}%</p>
            </div>
          </div>
        </div>

        <div className="card">
          <p className="text-sm font-medium text-slate-500">보기 전환</p>
          <div className="flex gap-1 bg-slate-100 p-1 rounded-2xl w-fit mt-4">
            {TABS.map(t => (
              <button
                key={t.key}
                className={`px-3 py-1.5 text-sm rounded-2xl font-medium transition-colors ${
                  tab === t.key ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'
                }`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <p className="text-sm text-slate-500 mt-4">진행 상태에 따라 프로젝트 목록을 빠르게 전환합니다.</p>
        </div>
      </div>

      {/* 탭 */}
      <div className="hidden">
        {TABS.map(t => (
          <button
            key={t.key}
            className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${
              tab === t.key ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'
            }`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 카드 그리드 */}
      {loading ? (
        <div className="text-center py-16 text-gray-400">로딩 중...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-4xl mb-3">📋</p>
          <p className="text-sm">프로젝트 없음</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(p => <ProjectCard key={p.id} project={p} />)}
        </div>
      )}

      {(proposal || notice) && (
        <PendingReviewSection
          hasPending={Boolean(proposal)}
          description="프로젝트 생성 제안을 아래 리스트에서 검토하고 확정하거나 반려합니다."
        >
          {proposal && (
            <div className="rounded-2xl border border-sky-200 bg-sky-50/40 px-4 py-4 space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-sky-700">프로젝트 생성 제안</p>
                  <h2 className="text-lg font-semibold text-slate-900 mt-1">{proposal.summary}</h2>
                  <p className="text-sm text-slate-600 mt-1">자연어 입력을 프로젝트 생성 제안으로 해석했습니다. 이름과 일정, 설명을 확인한 뒤 확정하세요.</p>
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold border ${proposalChanged(originalProposal, proposal)
                  ? 'border-amber-200 bg-amber-50 text-amber-700'
                  : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
                  {proposalChanged(originalProposal, proposal) ? '수정 있음' : '수정 없음'}
                </span>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-1 md:col-span-2">
                  <span className="text-xs font-semibold text-slate-500">프로젝트명</span>
                  <input className="input-base" value={proposal.name || ''} onChange={(e) => setProposal((prev) => ({ ...prev, name: e.target.value, summary: `${e.target.value} 프로젝트 생성 제안` }))} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-semibold text-slate-500">상태</span>
                  <select className="input-base" value={proposal.status || 'planning'} onChange={(e) => setProposal((prev) => ({ ...prev, status: e.target.value }))}>
                    <option value="planning">기획</option>
                    <option value="in_progress">진행중</option>
                    <option value="review">검토</option>
                    <option value="completed">완료</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-semibold text-slate-500">시작일</span>
                  <input type="date" className="input-base" value={proposal.start_date || ''} onChange={(e) => setProposal((prev) => ({ ...prev, start_date: e.target.value }))} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-semibold text-slate-500">마감일</span>
                  <input type="date" className="input-base" value={proposal.end_date || ''} onChange={(e) => setProposal((prev) => ({ ...prev, end_date: e.target.value }))} />
                </label>
                <label className="space-y-1 md:col-span-2">
                  <span className="text-xs font-semibold text-slate-500">설명</span>
                  <textarea className="input-base min-h-[88px]" value={proposal.description || ''} onChange={(e) => setProposal((prev) => ({ ...prev, description: e.target.value }))} />
                </label>
              </div>

              {Array.isArray(proposal.similar_cases) && proposal.similar_cases.length > 0 && (
                <div className="rounded-2xl border border-violet-200 bg-violet-50/70 px-4 py-4">
                  <p className="text-sm font-semibold text-violet-900">유사 확정 사례</p>
                  <div className="mt-3 space-y-2">
                    {proposal.similar_cases.map((item) => (
                      <div key={item.id} className="rounded-xl border border-violet-100 bg-white/90 px-3 py-3 text-sm text-slate-700">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-medium text-slate-900">{item.summary || '유사 프로젝트 생성 사례'}</p>
                          <span className="rounded-full bg-violet-100 px-2 py-1 text-[11px] font-semibold text-violet-700">
                            유사도 {(item.similarity * 100).toFixed(0)}%
                          </span>
                        </div>
                        <p className="mt-2 text-xs text-slate-600 whitespace-pre-wrap">{item.preview}</p>
                        <button
                          type="button"
                          className="mt-3 rounded-full border border-violet-200 bg-violet-100 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-200"
                          onClick={() => refillPrompt(`이 사례를 참고해서 프로젝트 생성 제안을 다시 정리해줘\n${item.preview || item.summary || ''}`.trim())}
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
                  onPromptFill={() => refillPrompt(`프로젝트 생성 제안을 다시 정리해줘\n이름: ${proposal.name || ''}\n시작일: ${proposal.start_date || ''}\n종료일: ${proposal.end_date || ''}`.trim())}
                  onSecondary={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
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

      {showCreate && canCreateProjects && <CreateModal onClose={() => setShowCreate(false)} onCreated={load} />}
    </div>
  );
}
