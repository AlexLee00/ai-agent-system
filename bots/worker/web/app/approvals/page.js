'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import ProposalFlowActions from '@/components/ProposalFlowActions';

const STATUS_LABELS = { pending: '대기', approved: '승인', rejected: '반려' };
const STATUS_COLORS = {
  pending:  'bg-yellow-100 text-yellow-800',
  approved: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-800',
};

function normalizeDraft(approval) {
  const payload = typeof approval.payload === 'string' ? JSON.parse(approval.payload) : (approval.payload || {});
  return {
    title: payload.title || approval.task_title || '',
    description: payload.description || approval.task_description || '',
  };
}

function resolveApprovalAction(approval) {
  const payload = typeof approval.payload === 'string' ? JSON.parse(approval.payload) : (approval.payload || {});
  const category = approval.category || '';
  const action = approval.action || '';

  if (category === 'leave_request') {
    return { href: '/attendance', prompt: '대기 중인 휴가 신청 내역 보여줘' };
  }
  if (category === 'employee_create' || action.includes('직원')) {
    return { href: '/employees', prompt: '대기 중인 직원 등록 요청 요약해줘' };
  }
  if (category === 'payroll' || action.includes('급여')) {
    return { href: '/payroll', prompt: '대기 중인 급여 관련 승인 요청 보여줘' };
  }
  if (approval.target_table === 'agent_tasks') {
    if (approval.target_bot === 'Noah') return { href: '/attendance', prompt: '대기 중인 근태/인사 승인 요청 보여줘' };
    if (approval.target_bot === 'Sophie') return { href: '/payroll', prompt: '대기 중인 급여 승인 요청 보여줘' };
    if (approval.target_bot === 'Chloe') return { href: '/schedules', prompt: '대기 중인 일정 승인 요청 보여줘' };
    if (approval.target_bot === 'Oliver') return { href: '/sales', prompt: '대기 중인 매출 승인 요청 보여줘' };
    if (approval.target_bot === 'Ryan') return { href: '/projects', prompt: '대기 중인 프로젝트/업무 승인 요청 보여줘' };
  }
  if (payload.date || payload.reason) {
    return { href: '/attendance', prompt: '대기 중인 근태 관련 승인 요청 보여줘' };
  }
  return { href: '/chat', prompt: '대기 중인 승인 요청 요약해줘' };
}

export default function ApprovalsPage() {
  const router = useRouter();
  const [approvals, setApprovals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProc] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [activeTab, setActiveTab] = useState('pending');

  const load = () => {
    setLoading(true);
    api.get('/approvals')
      .then(data => {
        const rows = data.approvals || [];
        setApprovals(rows);
        setDrafts(prev => {
          const next = { ...prev };
          for (const approval of rows) {
            if (!next[approval.id]) {
              next[approval.id] = normalizeDraft(approval);
            }
          }
          return next;
        });
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const pendingCount = useMemo(
    () => approvals.filter(item => item.status === 'pending').length,
    [approvals]
  );
  const approvedCount = useMemo(
    () => approvals.filter(item => item.status === 'approved').length,
    [approvals]
  );
  const rejectedCount = useMemo(
    () => approvals.filter(item => item.status === 'rejected').length,
    [approvals]
  );
  const visibleApprovals = useMemo(
    () => approvals.filter(item => activeTab === 'all' ? true : item.status === activeTab),
    [approvals, activeTab]
  );

  const handleDraftChange = (id, key, value) => {
    setDrafts(prev => ({
      ...prev,
      [id]: {
        ...(prev[id] || {}),
        [key]: value,
      },
    }));
  };

  const handleReviewSave = async (approval) => {
    const draft = drafts[approval.id] || normalizeDraft(approval);
    setProc(`review:${approval.id}`);
    try {
      await api.put(`/approvals/${approval.id}/review`, {
        title: draft.title,
        description: draft.description,
      });
      load();
    } catch (e) {
      alert(e.message);
    } finally {
      setProc(null);
    }
  };

  const handleApprove = async (id) => {
    setProc(`approve:${id}`);
    try {
      await api.put(`/approvals/${id}/approve`);
      load();
    } catch (e) {
      alert(e.message);
    } finally {
      setProc(null);
    }
  };

  const handleReject = async (id) => {
    const reason = prompt('반려 사유를 입력하세요:');
    if (!reason) return;
    setProc(`reject:${id}`);
    try {
      await api.put(`/approvals/${id}/reject`, { reason });
      load();
    } catch (e) {
      alert(e.message);
    } finally {
      setProc(null);
    }
  };

  const tabItems = [
    { key: 'pending', label: '대기', count: pendingCount },
    { key: 'approved', label: '승인', count: approvedCount },
    { key: 'rejected', label: '반려', count: rejectedCount },
    { key: 'all', label: '전체', count: approvals.length },
  ];

  const openPrompt = (approval) => {
    const action = resolveApprovalAction(approval);
    const query = new URLSearchParams({ prompt: action.prompt }).toString();
    router.push(`${action.href}?${query}`);
  };

  const openMenu = (approval) => {
    router.push(resolveApprovalAction(approval).href);
  };

  return (
    <div className="space-y-4">
      <div className="card bg-gradient-to-br from-white to-slate-100/80">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-slate-900">✅ 승인 관리</h1>
            <p className="text-sm text-slate-500 mt-2">AI가 만든 업무 초안을 검토하고, 필요하면 수정한 뒤 승인 또는 반려하는 전체 inbox입니다.</p>
          </div>
          <div className="rounded-[1.25rem] border border-slate-200 bg-white px-4 py-4 min-w-[180px]">
            <p className="text-xs text-slate-500">현재 우선 확인</p>
            <p className="text-2xl font-semibold text-slate-900 mt-1">{pendingCount}건</p>
            <p className="text-xs text-slate-400 mt-2">대기 승인 inbox</p>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-4">
          <div className="rounded-[1.25rem] border border-amber-200 bg-amber-50 px-4 py-4">
            <p className="text-xs text-amber-700">대기</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">{pendingCount}건</p>
            <p className="mt-2 text-xs text-amber-800">지금 처리할 승인 요청</p>
          </div>
          <div className="rounded-[1.25rem] border border-emerald-200 bg-emerald-50 px-4 py-4">
            <p className="text-xs text-emerald-700">승인 완료</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">{approvedCount}건</p>
            <p className="mt-2 text-xs text-emerald-800">최근 승인 처리</p>
          </div>
          <div className="rounded-[1.25rem] border border-rose-200 bg-rose-50 px-4 py-4">
            <p className="text-xs text-rose-700">반려</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">{rejectedCount}건</p>
            <p className="mt-2 text-xs text-rose-800">사유 확인 필요</p>
          </div>
          <div className="rounded-[1.25rem] border border-slate-200 bg-white px-4 py-4">
            <p className="text-xs text-slate-500">전체</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">{approvals.length}건</p>
            <p className="mt-2 text-xs text-slate-400">누적 승인 흐름</p>
          </div>
        </div>
      </div>

      <div className="card bg-white">
        <div className="flex flex-wrap gap-2">
          {tabItems.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === tab.key
                  ? 'bg-slate-900 text-white'
                  : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {tab.label} {tab.count}건
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="text-center py-20 text-slate-400">로딩 중...</p>
      ) : visibleApprovals.length === 0 ? (
        <div className="card text-center py-12 text-slate-400">
          <p className="text-4xl mb-2">✅</p>
          <p>{activeTab === 'pending' ? '대기 중인 승인 요청 없음' : '선택한 상태의 승인 요청이 없습니다.'}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {visibleApprovals.map(approval => {
            const payload = typeof approval.payload === 'string' ? JSON.parse(approval.payload) : (approval.payload || {});
            const draft = drafts[approval.id] || normalizeDraft(approval);
            const canReview = approval.status === 'pending' && approval.target_table === 'agent_tasks';

            return (
              <div key={approval.id} className="card">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[approval.status]}`}>
                        {STATUS_LABELS[approval.status]}
                      </span>
                      <span className="text-xs text-slate-500">#{approval.id}</span>
                      <span className="text-xs text-slate-500">
                        {approval.priority === 'urgent' ? '🚨 긴급' : '📋 일반'}
                      </span>
                    </div>
                    <p className="font-medium text-slate-900">{approval.action}</p>
                    <p className="text-sm text-slate-500">신청자: {approval.requester_name || approval.requester_id}</p>
                    {approval.target_bot && (
                      <p className="text-sm text-slate-500">대상 봇: {approval.target_bot}</p>
                    )}

                    {canReview ? (
                      <div className="mt-4 space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                        <div>
                          <label className="block text-xs font-semibold text-slate-600 mb-1">업무 제목</label>
                          <input
                            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
                            value={draft.title}
                            onChange={(e) => handleDraftChange(approval.id, 'title', e.target.value)}
                            placeholder="AI가 제안한 업무 제목"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-slate-600 mb-1">업무 설명</label>
                          <textarea
                            className="w-full min-h-[96px] rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
                            value={draft.description}
                            onChange={(e) => handleDraftChange(approval.id, 'description', e.target.value)}
                            placeholder="승인 전에 설명을 다듬을 수 있습니다."
                          />
                        </div>
                        <div className="rounded-xl bg-white px-3 py-3 text-xs text-slate-500">
                          <p>원본 요청: {payload.description || approval.task_description || '-'}</p>
                        </div>
                      </div>
                    ) : (
                      <>
                        {approval.task_title && (
                          <p className="text-sm text-slate-500 mt-2">업무: {approval.task_title}</p>
                        )}
                        {payload.description && (
                          <p className="text-sm text-slate-500 mt-1 whitespace-pre-wrap">{payload.description}</p>
                        )}
                        {payload.date && <p className="text-sm text-slate-500 mt-1">날짜: {payload.date}</p>}
                        {payload.reason && <p className="text-sm text-slate-500 mt-1">사유: {payload.reason}</p>}
                      </>
                    )}

                    <p className="text-xs text-slate-400 mt-3">{new Date(approval.created_at).toLocaleString('ko-KR')}</p>
                    <div className="mt-4">
                      <ProposalFlowActions
                        onPromptFill={() => openPrompt(approval)}
                        onSecondary={() => openMenu(approval)}
                        secondaryLabel="관련 메뉴 열기"
                      />
                    </div>
                  </div>

                  {approval.status === 'pending' && (
                    <div className="flex flex-col gap-2 shrink-0">
                      {canReview && (
                        <button
                          className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700"
                          disabled={processing === `review:${approval.id}`}
                          onClick={() => handleReviewSave(approval)}
                        >
                          💾 수정 저장
                        </button>
                      )}
                      <button
                        className="btn-primary text-sm px-4 py-2"
                        disabled={processing === `approve:${approval.id}`}
                        onClick={() => handleApprove(approval.id)}
                      >
                        ✅ 승인
                      </button>
                      <button
                        className="btn-danger text-sm px-4 py-2"
                        disabled={processing === `reject:${approval.id}`}
                        onClick={() => handleReject(approval.id)}
                      >
                        ❌ 반려
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
