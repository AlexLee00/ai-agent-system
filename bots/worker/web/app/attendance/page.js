'use client';
import { useState, useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import DataTable from '@/components/DataTable';
import { useAuth } from '@/lib/auth-context';
import AdminQuickNav from '@/components/AdminQuickNav';
import AdminPageHero from '@/components/AdminPageHero';
import AdminQuickFlowGrid from '@/components/AdminQuickFlowGrid';
import Modal from '@/components/Modal';
import { canPerformMenuOperation } from '@/lib/menu-access';
import PendingReviewSection from '@/components/PendingReviewSection';
import ProposalFlowActions from '@/components/ProposalFlowActions';
import PromptAdvisor from '@/components/PromptAdvisor';

function fmtTime(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

function renderCheckoutText(ts) {
  if (!ts) return '미퇴근';
  return `${fmtTime(ts)} 퇴근`;
}

function fmtDate(value) {
  if (!value) return '-';
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const [year, month, day] = String(value).split('-');
    return `${year}.${month}.${day}`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).replace(/\.\s/g, '.').replace(/\.$/, '');
}

function toDateTimeLocal(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromDateTimeLocal(value) {
  if (!value) return null;
  return `${value}:00+09:00`;
}

function proposalChanged(original, proposal) {
  if (!original || !proposal) return false;
  return ['action', 'occurred_at', 'note'].some((key) => (original[key] || '') !== (proposal[key] || ''));
}

function buildProposalSummary(proposal) {
  if (!proposal?.occurred_at) return '';
  const actionLabel = proposal.action === 'checkout' ? '퇴근' : '출근';
  return new Date(proposal.occurred_at).toLocaleString('ko-KR', {
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }) + ` ${actionLabel}`;
}

function leaveProposalChanged(original, proposal) {
  if (!original || !proposal) return false;
  return ['leave_date', 'leave_type', 'reason'].some((key) => (original[key] || '') !== (proposal[key] || ''));
}

export default function AttendancePage() {
  const { user } = useAuth();
  const [records, setRecords]     = useState([]);
  const [leaveRecords, setLeaveRecords] = useState([]);
  const [leaveApprovals, setLeaveApprovals] = useState([]);
  const today = new Date().toISOString().slice(0,10);
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate]     = useState(today);
  const [activeTab, setActiveTab] = useState('attendance');
  const [loading, setLoading]     = useState(true);
  const [checking, setChecking]   = useState('');
  const [prompt, setPrompt]       = useState('');
  const [proposal, setProposal]   = useState(null);
  const [originalProposal, setOriginalProposal] = useState(null);
  const [leaveProposal, setLeaveProposal] = useState(null);
  const [originalLeaveProposal, setOriginalLeaveProposal] = useState(null);
  const [proposalLoading, setProposalLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [editRow, setEditRow] = useState(null);
  const [editForm, setEditForm] = useState({ check_in: '', check_out: '', status: 'present', note: '' });
  const [editSaving, setEditSaving] = useState(false);
  const [approvalProcessing, setApprovalProcessing] = useState('');
  const promptRef = useRef(null);

  useEffect(() => {
    const node = promptRef.current;
    if (!node) return;
    const baseHeight = 24;
    node.style.height = `${baseHeight}px`;
    const nextHeight = node.scrollHeight <= 28 ? baseHeight : node.scrollHeight;
    node.style.height = `${nextHeight}px`;
  }, [prompt]);

  const refillPrompt = (text) => {
    setPrompt(text);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const load = (nextStartDate = startDate, nextEndDate = endDate) => {
    setLoading(true);
    const params = new URLSearchParams({
      start_date: nextStartDate,
      end_date: nextEndDate,
    });
    Promise.all([
      api.get(`/attendance?${params.toString()}`).catch(() => ({ attendance: [] })),
      api.get(`/attendance/leave-status?${params.toString()}`).catch(() => ({ leave_requests: [] })),
      canManageAttendance
        ? api.get('/attendance/leave-approvals').catch(() => ({ leave_approvals: [] }))
        : Promise.resolve({ leave_approvals: [] }),
    ])
      .then(([attendanceData, leaveData, leaveApprovalData]) => {
        setRecords(attendanceData.attendance || []);
        setLeaveRecords(leaveData.leave_requests || []);
        setLeaveApprovals(leaveApprovalData.leave_approvals || []);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(startDate, endDate); }, [startDate, endDate]);

  const createProposal = async (payload) => {
    setProposalLoading(true);
    setError('');
    setNotice('');
    try {
      const data = await api.post('/attendance/proposals', payload);
      setProposal(data.proposal || null);
      setOriginalProposal(data.proposal || null);
      setLeaveProposal(null);
      setOriginalLeaveProposal(null);
      if (payload.prompt) setPrompt('');
    } catch (e) {
      setError(e.message);
    } finally {
      setProposalLoading(false);
    }
  };

  const createLeaveProposal = async (promptText) => {
    const nextPrompt = (promptText || prompt || '').trim();
    if (!nextPrompt) return;
    setProposalLoading(true);
    setError('');
    setNotice('');
    try {
      const data = await api.post('/leave/proposals', { prompt: nextPrompt });
      setLeaveProposal(data.proposal || null);
      setOriginalLeaveProposal(data.proposal || null);
      setProposal(null);
      setOriginalProposal(null);
      setPrompt('');
    } catch (e) {
      setError(e.message);
    } finally {
      setProposalLoading(false);
    }
  };

  const handleCheckIn = async () => {
    setChecking('in');
    await createProposal({ action: 'checkin' });
    setChecking('');
  };

  const handleCheckOut = async () => {
    setChecking('out');
    await createProposal({ action: 'checkout' });
    setChecking('');
  };

  const handlePromptSubmit = async () => {
    const nextPrompt = prompt.trim();
    if (!nextPrompt) return;
    const isLeavePrompt = /(연차|반차|외근|휴가)/.test(nextPrompt);
    if (isLeavePrompt) {
      await createLeaveProposal(nextPrompt);
      return;
    }
    await createProposal({ prompt: nextPrompt });
  };

  const handleConfirmProposal = async () => {
    if (!proposal?.feedback_session_id) return;
    setProposalLoading(true);
    setError('');
    try {
      await api.post(`/attendance/proposals/${proposal.feedback_session_id}/confirm`, { proposal });
      setNotice(`${proposal.action_label} 제안을 확정했습니다.`);
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
      await api.post(`/attendance/proposals/${proposal.feedback_session_id}/reject`, {});
      setNotice('근태 제안을 반려했습니다.');
      setProposal(null);
      setOriginalProposal(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setProposalLoading(false);
    }
  };

  const handleConfirmLeaveProposal = async () => {
    if (!leaveProposal?.feedback_session_id) return;
    setProposalLoading(true);
    setError('');
    try {
      await api.post(`/leave/proposals/${leaveProposal.feedback_session_id}/confirm`, { proposal: leaveProposal });
      setNotice('휴가 신청을 접수했습니다. 관리자 승인 대기 중입니다.');
      setLeaveProposal(null);
      setOriginalLeaveProposal(null);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setProposalLoading(false);
    }
  };

  const handleRejectLeaveProposal = async () => {
    if (!leaveProposal?.feedback_session_id) return;
    setProposalLoading(true);
    setError('');
    try {
      await api.post(`/leave/proposals/${leaveProposal.feedback_session_id}/reject`, {});
      setNotice('휴가 제안을 반려했습니다.');
      setLeaveProposal(null);
      setOriginalLeaveProposal(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setProposalLoading(false);
    }
  };

  const openEdit = (row) => {
    setEditRow(row);
    setEditForm({
      check_in: toDateTimeLocal(row.check_in),
      check_out: toDateTimeLocal(row.check_out),
      status: row.status || 'present',
      note: row.note || '',
    });
    setError('');
  };

  const handleSaveEdit = async (e) => {
    e.preventDefault();
    if (!editRow) return;
    setEditSaving(true);
    setError('');
    try {
      await api.put(`/attendance/${editRow.id}`, {
        check_in: fromDateTimeLocal(editForm.check_in),
        check_out: fromDateTimeLocal(editForm.check_out),
        status: editForm.status,
        note: editForm.note,
      });
      setNotice('근태 기록을 수정했습니다.');
      setEditRow(null);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setEditSaving(false);
    }
  };

  const handleDeleteRecord = async (row) => {
    if (!confirm(`${row.employee_name} 근태 기록을 삭제하시겠습니까?`)) return;
    try {
      await api.delete(`/attendance/${row.id}`);
      setNotice('근태 기록을 삭제했습니다.');
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  const checkedIn  = records.filter(r => r.check_in).length;
  const checkedOut = records.filter(r => r.check_out).length;
  const lateCount = records.filter(r => r.status === 'late').length;
  const isMember = user?.role === 'member';
  const canCreateTodayOnly = canPerformMenuOperation(user, 'attendance', 'create_today_only');
  const canManageAttendance = canPerformMenuOperation(user, 'attendance', 'update');
  const pendingLeaveCount = canManageAttendance
    ? leaveApprovals.length
    : leaveRecords.filter((row) => row.status === 'pending').length;

  useEffect(() => {
    if (activeTab === 'leave-approvals' && !canManageAttendance) {
      setActiveTab('attendance');
    }
  }, [activeTab, canManageAttendance]);
  const quickFlows = [];
  const columns = [
    { key: 'date', label: '날짜', render: (value) => fmtDate(value) },
    { key: 'employee_name', label: '이름' },
    { key: 'check_in',      label: '출근', render: v => fmtTime(v) },
    { key: 'check_out',     label: '퇴근', render: v => renderCheckoutText(v) },
    { key: 'status',        label: '상태', render: v => ({
      present: '✅ 출근', late: '⚠️ 지각', absent: '❌ 결근', leave: '🏖️ 휴가',
    }[v] || v) },
  ];
  const leaveColumns = [
    { key: 'leave_date', label: '휴가 날짜', render: (value) => fmtDate(value) },
    { key: 'employee_name', label: '이름' },
    { key: 'leave_type_label', label: '유형' },
    { key: 'reason', label: '사유', render: (value) => value || '-' },
    {
      key: 'status',
      label: '상태',
      render: (value) => ({
        pending: '📝 검토중',
        approved: '✅ 승인',
        rejected: '❌ 반려',
      }[value] || value || '-'),
    },
  ];
  const leaveApprovalColumns = [
    { key: 'employee_name', label: '이름' },
    { key: 'leave_date', label: '휴가 날짜', render: (value) => fmtDate(value) },
    { key: 'leave_type_label', label: '유형' },
    { key: 'reason', label: '사유', render: (value) => value || '-' },
  ];

  const handleApproveLeave = async (row) => {
    setApprovalProcessing(`approve:${row.id}`);
    setError('');
    setNotice('');
    try {
      await api.put(`/approvals/${row.id}/approve`);
      setNotice(`${row.employee_name}님의 휴가 신청을 승인했습니다.`);
      if (row.leave_date) {
        setStartDate(row.leave_date);
        setEndDate(row.leave_date);
        setActiveTab('leave');
        load(row.leave_date, row.leave_date);
      } else {
        load();
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setApprovalProcessing('');
    }
  };

  const handleRejectLeave = async (row) => {
    const reason = window.prompt(`${row.employee_name}님의 휴가 신청 반려 사유를 입력하세요.`);
    if (!reason) return;
    setApprovalProcessing(`reject:${row.id}`);
    setError('');
    setNotice('');
    try {
      await api.put(`/approvals/${row.id}/reject`, { reason });
      setNotice(`${row.employee_name}님의 휴가 신청을 반려했습니다.`);
      if (row.leave_date) {
        setStartDate(row.leave_date);
        setEndDate(row.leave_date);
        setActiveTab('leave');
        load(row.leave_date, row.leave_date);
      } else {
        load();
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setApprovalProcessing('');
    }
  };
  const pendingReviewSection = (proposal || leaveProposal) ? (
    <PendingReviewSection
      title="확인 및 승인 대기 리스트"
      description="프롬프트 입력은 위에서 한 번만 하고, 실제 확정/신청/반려는 아래 처리 리스트에서 진행합니다."
      hasPending={Boolean(proposal || leaveProposal)}
      badgeLabel={proposal && leaveProposal ? '2건 대기 중' : '1건 대기 중'}
    >
      <div className="space-y-3">
        {proposal && (
          <div className="rounded-3xl border border-sky-200 bg-sky-50/40 px-5 py-5 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-sky-700">근태 확인 항목</p>
                <h3 className="text-lg font-semibold text-slate-900 mt-1">{proposal.summary}</h3>
                <p className="text-sm text-slate-600 mt-1">
                  AI가 자연어 입력을 근태 기록으로 해석했습니다. 그대로 확정하거나 수정 후 확정하세요.
                </p>
              </div>
              <div className="flex flex-col items-end gap-2 text-right">
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
              <label className="space-y-1">
                <span className="text-xs font-semibold text-slate-500">업무 유형</span>
                <select
                  className="input-base"
                  value={proposal.action}
                  onChange={(e) => setProposal((prev) => ({
                    ...prev,
                    action: e.target.value,
                    action_label: e.target.value === 'checkout' ? '퇴근' : '출근',
                    summary: buildProposalSummary({
                      ...prev,
                      action: e.target.value,
                    }),
                  }))}
                >
                  <option value="checkin">출근</option>
                  <option value="checkout">퇴근</option>
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold text-slate-500">기록 시각</span>
                <input
                  type="datetime-local"
                  className="input-base"
                  value={toDateTimeLocal(proposal.occurred_at)}
                  onChange={(e) => setProposal((prev) => ({
                    ...prev,
                    occurred_at: fromDateTimeLocal(e.target.value),
                    summary: buildProposalSummary({
                      ...prev,
                      occurred_at: fromDateTimeLocal(e.target.value),
                    }),
                  }))}
                />
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-2 md:items-stretch">
              <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-700 h-full">
                <p><span className="font-semibold text-slate-900">대상</span> {proposal.employee_name}</p>
                <p className="mt-1"><span className="font-semibold text-slate-900">예정 기록</span> {proposal.summary}</p>
              </div>
              <label className="space-y-1 h-full flex flex-col">
                <span className="text-xs font-semibold text-slate-500">메모</span>
                <textarea
                  className="input-base min-h-[88px] h-full"
                  value={proposal.note || ''}
                  onChange={(e) => setProposal((prev) => ({
                    ...prev,
                    note: e.target.value,
                  }))}
                  placeholder="필요하면 메모를 남길 수 있습니다."
                />
              </label>
            </div>

            {Array.isArray(proposal.similar_cases) && proposal.similar_cases.length > 0 && (
              <div className="rounded-2xl border border-violet-200 bg-violet-50/70 px-4 py-4">
                <p className="text-sm font-semibold text-violet-900">유사 확정 사례</p>
                <p className="text-xs text-violet-700 mt-1">
                  수정 없이 확정된 과거 사례를 참고해 현재 제안을 빠르게 판단할 수 있습니다.
                </p>
                <div className="mt-3 space-y-2">
                  {proposal.similar_cases.map((item) => (
                    <div key={item.id} className="rounded-xl border border-violet-100 bg-white/90 px-3 py-3 text-sm text-slate-700">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium text-slate-900">{item.summary || '유사 근태 사례'}</p>
                        <span className="rounded-full bg-violet-100 px-2 py-1 text-[11px] font-semibold text-violet-700">
                          유사도 {(item.similarity * 100).toFixed(0)}%
                        </span>
                      </div>
                      <p className="mt-2 text-xs text-slate-600 whitespace-pre-wrap">{item.preview}</p>
                      <button
                        type="button"
                        className="mt-3 rounded-full border border-violet-200 bg-violet-100 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-200"
                        onClick={() => refillPrompt(`이 사례를 참고해서 근태 기록 제안을 다시 정리해줘\n${item.preview || item.summary || ''}`.trim())}
                      >
                        이 사례로 다시 작성
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className="btn-primary"
                onClick={handleConfirmProposal}
                disabled={proposalLoading}
              >
                {proposalLoading ? '제출 중...' : '제출하기'}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={handleRejectProposal}
                disabled={proposalLoading}
              >
                삭제
              </button>
            </div>
          </div>
        )}

        {leaveProposal && (
          <div className="rounded-3xl border border-violet-200 bg-violet-50/40 px-5 py-5 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-violet-700">휴가 신청 확인 항목</p>
                <h3 className="text-lg font-semibold text-slate-900 mt-1">{leaveProposal.summary}</h3>
                <p className="text-sm text-slate-600 mt-1">
                  자연어 입력을 휴가 신청서로 해석했습니다. 수정 후 접수하거나 반려할 수 있습니다.
                </p>
              </div>
              <div className="flex flex-col items-end gap-2 text-right">
                <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600 border border-slate-200">
                  {leaveProposal.confidence === 'high' ? '해석 신뢰도 높음' : '해석 신뢰도 보통'}
                </span>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold border ${leaveProposalChanged(originalLeaveProposal, leaveProposal)
                  ? 'border-amber-200 bg-amber-50 text-amber-700'
                  : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
                  {leaveProposalChanged(originalLeaveProposal, leaveProposal) ? '수정 있음' : '수정 없음'}
                </span>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs font-semibold text-slate-500">유형</span>
                <select
                  className="input-base"
                  value={leaveProposal.leave_type}
                  onChange={(e) => setLeaveProposal((prev) => {
                    const nextType = e.target.value;
                    const nextLabel = nextType === 'half_day' ? '반차' : nextType === 'field_work' ? '외근' : '연차';
                    return {
                      ...prev,
                      leave_type: nextType,
                      leave_type_label: nextLabel,
                      summary: `${prev.leave_date} ${nextLabel} 신청`,
                    };
                  })}
                >
                  <option value="annual_leave">연차</option>
                  <option value="half_day">반차</option>
                  <option value="field_work">외근</option>
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold text-slate-500">휴가 날짜</span>
                <input
                  type="date"
                  className="input-base"
                  value={leaveProposal.leave_date}
                  onChange={(e) => setLeaveProposal((prev) => ({
                    ...prev,
                    leave_date: e.target.value,
                    summary: `${e.target.value} ${prev.leave_type_label} 신청`,
                  }))}
                />
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-2 md:items-stretch">
              <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-700 h-full">
                <p><span className="font-semibold text-slate-900">신청자</span> {leaveProposal.employee_name}</p>
                <p className="mt-1"><span className="font-semibold text-slate-900">신청 내용</span> {leaveProposal.summary}</p>
                <p className="mt-1"><span className="font-semibold text-slate-900">처리 방식</span> 접수 후 관리자 승인 대기 상태로 넘어갑니다.</p>
              </div>
              <label className="space-y-1 h-full flex flex-col">
                <span className="text-xs font-semibold text-slate-500">사유</span>
                <textarea
                  className="input-base min-h-[88px] h-full"
                  value={leaveProposal.reason || ''}
                  onChange={(e) => setLeaveProposal((prev) => ({
                    ...prev,
                    reason: e.target.value,
                  }))}
                  placeholder="휴가 사유를 입력하세요."
                />
              </label>
            </div>

            {Array.isArray(leaveProposal.similar_cases) && leaveProposal.similar_cases.length > 0 && (
              <div className="rounded-2xl border border-violet-200 bg-violet-50/70 px-4 py-4">
                <p className="text-sm font-semibold text-violet-900">유사 확정 사례</p>
                <div className="mt-3 space-y-2">
                  {leaveProposal.similar_cases.map((item) => (
                    <div key={item.id} className="rounded-xl border border-violet-100 bg-white/90 px-3 py-3 text-sm text-slate-700">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium text-slate-900">{item.summary || '유사 휴가 사례'}</p>
                        <span className="rounded-full bg-violet-100 px-2 py-1 text-[11px] font-semibold text-violet-700">
                          유사도 {(item.similarity * 100).toFixed(0)}%
                        </span>
                      </div>
                      <p className="mt-2 text-xs text-slate-600 whitespace-pre-wrap">{item.preview}</p>
                      <button
                        type="button"
                        className="mt-3 rounded-full border border-violet-200 bg-violet-100 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-200"
                        onClick={() => refillPrompt(`이 사례를 참고해서 휴가 신청 제안을 다시 정리해줘\n${item.preview || item.summary || ''}`.trim())}
                      >
                        이 사례로 다시 작성
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className="btn-primary"
                onClick={handleConfirmLeaveProposal}
                disabled={proposalLoading}
              >
                {proposalLoading ? '제출 중...' : '제출하기'}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={handleRejectLeaveProposal}
                disabled={proposalLoading}
              >
                삭제
              </button>
            </div>
          </div>
        )}
      </div>
    </PendingReviewSection>
  ) : null;

  const tabItems = [
    { key: 'attendance', label: '근태현황' },
    { key: 'leave', label: '휴가' },
    ...(canManageAttendance ? [{ key: 'leave-approvals', label: `휴가 승인(${pendingLeaveCount}명)` }] : []),
  ];

  const activeSummary = activeTab === 'leave'
    ? (
      <>
        <div><span className="text-slate-500">승인 대기</span> <strong>{pendingLeaveCount}건</strong></div>
        <div><span className="text-slate-500">전체</span> <strong>{leaveRecords.length}건</strong></div>
      </>
    ) : activeTab === 'leave-approvals'
      ? (
        <>
          <div><span className="text-slate-500">승인 대기</span> <strong>{leaveApprovals.length}건</strong></div>
          <div><span className="text-slate-500">회사 전체</span> <strong>{leaveApprovals.length}건</strong></div>
        </>
      )
      : (
        <>
          <div><span className="text-slate-500">총 출근</span> <strong>{checkedIn}명</strong></div>
          <div><span className="text-slate-500">전체</span> <strong>{records.length}명</strong></div>
        </>
      );

  let activeTable = (
    <DataTable
      columns={columns}
      data={records}
      pageSize={10}
      emptyText="근태 기록 없음"
      mobileRowRender={(row, rowActions) => (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
              <p className="text-[11px] font-medium text-slate-500">날짜</p>
              <p className="mt-1 text-sm font-medium text-slate-900">{fmtDate(row.date)}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
              <p className="text-[11px] font-medium text-slate-500">이름</p>
              <p className="mt-1 text-sm font-medium text-slate-900">{row.employee_name || '-'}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
              <p className="text-[11px] font-medium text-slate-500">출근</p>
              <p className="mt-1 text-sm font-medium text-slate-900">{fmtTime(row.check_in)}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
              <p className="text-[11px] font-medium text-slate-500">퇴근</p>
              <p className="mt-1 text-sm font-medium text-slate-900">{renderCheckoutText(row.check_out)}</p>
            </div>
          </div>
          <div className="mt-3 rounded-2xl border border-slate-200 bg-white px-3 py-3">
            <p className="text-[11px] font-medium text-slate-500">상태</p>
            <p className="mt-1 text-sm font-medium text-slate-900">{({
              present: '✅ 출근', late: '⚠️ 지각', absent: '❌ 결근', leave: '🏖️ 휴가',
            }[row.status] || row.status || '-')}</p>
          </div>
          {rowActions ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {rowActions(row)}
            </div>
          ) : null}
        </>
      )}
      actions={canManageAttendance ? (row) => (
        <>
          <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => openEdit(row)}>수정</button>
          <button className="btn-danger text-xs px-3 py-1.5" onClick={() => handleDeleteRecord(row)}>삭제</button>
        </>
      ) : undefined}
    />
  );

  if (activeTab === 'leave') {
    activeTable = (
      <DataTable
        columns={leaveColumns}
        data={leaveRecords}
        pageSize={10}
        emptyText="휴가 신청 기록 없음"
      />
    );
  }

  if (activeTab === 'leave-approvals') {
    activeTable = (
      <DataTable
        columns={leaveApprovalColumns}
        data={leaveApprovals}
        pageSize={10}
        emptyText="승인 대기 중인 휴가 신청 없음"
        actions={(row) => (
          <>
            <button
              className="btn-primary text-xs px-3 py-1.5"
              disabled={approvalProcessing === `approve:${row.id}`}
              onClick={() => handleApproveLeave(row)}
            >
              승인
            </button>
            <button
              className="btn-danger text-xs px-3 py-1.5"
              disabled={approvalProcessing === `reject:${row.id}`}
              onClick={() => handleRejectLeave(row)}
            >
              반려
            </button>
          </>
        )}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {!isMember && <AdminQuickNav />}

      {!isMember && (
        <AdminPageHero
          title="근태 관리"
          description="출근, 퇴근, 휴가 신청과 예외 근태를 한 화면에서 확인하고 처리합니다."
          stats={[
            {
              label: '출근',
              value: `${checkedIn}명`,
              caption: '오늘 기준',
              body: '오늘 출근 처리된 인원 기준으로 집계합니다.',
            },
            {
              label: '퇴근',
              value: `${checkedOut}명`,
              caption: '오늘 기준',
              body: '오늘 퇴근 처리된 인원 기준으로 집계합니다.',
            },
            {
              label: '지각',
              value: `${lateCount}건`,
              caption: 'status=late',
              body: '지각 상태로 기록된 근태 건수를 먼저 확인합니다.',
            },
            {
              label: '승인 대기',
              value: `${pendingLeaveCount}건`,
              caption: '휴가 승인 요청',
              body: '관리자 확인이 필요한 휴가 승인 대기 건수입니다.',
            },
          ]}
        />
      )}

      {!isMember && <AdminQuickFlowGrid items={quickFlows} />}

      <PromptAdvisor
        title="프롬프트 어드바이저"
        description="출근, 퇴근, 휴가, 근태 수정 요청을 자연어로 정리하고 바로 확인 결과로 이어집니다."
        badge={`Noah 근태 ${user?.role === 'master' ? '오케스트레이터' : user?.role === 'admin' ? '운영 에이전트' : '에이전트'}`}
        suggestions={[
          '출근했어요',
          '퇴근합니다',
          '내일 연차 신청',
          '오늘 오전 9시 출근으로 수정해줘',
        ]}
        helperText="출근, 퇴근, 연차, 반차, 외근, 근태 수정처럼 근태 처리 요청을 빠르게 확인 결과로 넘길 때 적합합니다."
        prompt={prompt}
        onPromptChange={setPrompt}
        promptRef={promptRef}
        placeholder="출근, 퇴근, 연차, 반차, 외근 요청을 자연어로 입력하세요."
        onReset={() => {
          setPrompt('');
          setError('');
          setNotice('');
        }}
        showFileButton={false}
        onSubmit={handlePromptSubmit}
        submitDisabled={proposalLoading || !prompt.trim()}
        error={error}
        notice={notice}
      />

      {pendingReviewSection}

      <div className="card">
        <div className="flex flex-col gap-4 border-b border-slate-200 pb-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:flex-wrap">
            <label className="flex w-full items-center justify-between gap-3 sm:w-auto sm:justify-start">
              <span className="w-14 shrink-0 text-xs font-semibold text-slate-500">시작날짜</span>
              <input
                type="date"
                className="input-base w-[calc(100%-4.25rem)] sm:min-w-[150px] sm:w-auto"
                value={startDate}
                onChange={(e) => {
                  const value = e.target.value;
                  setStartDate(value);
                  if (value > endDate) setEndDate(value);
                }}
              />
            </label>
            <label className="flex w-full items-center justify-between gap-3 sm:w-auto sm:justify-start">
              <span className="w-14 shrink-0 text-xs font-semibold text-slate-500">종료날짜</span>
              <input
                type="date"
                className="input-base w-[calc(100%-4.25rem)] sm:min-w-[150px] sm:w-auto"
                value={endDate}
                min={startDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </label>
          </div>
          <div className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm sm:w-auto sm:justify-end">
            {activeSummary}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {tabItems.map((tab) => (
            <button
              type="button"
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                activeTab === tab.key
                  ? 'bg-slate-900 text-white'
                  : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="mt-5 sm:mt-4">
        {loading
          ? <p className="py-10 text-center text-gray-400">로딩 중...</p>
          : activeTable
        }
        </div>
      </div>

      <Modal open={!!editRow} onClose={() => setEditRow(null)} title="근태 기록 수정">
        <form onSubmit={handleSaveEdit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">출근 시각</label>
            <input
              type="datetime-local"
              className="input-base"
              value={editForm.check_in}
              onChange={(e) => setEditForm((prev) => ({ ...prev, check_in: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">퇴근 시각</label>
            <input
              type="datetime-local"
              className="input-base"
              value={editForm.check_out}
              onChange={(e) => setEditForm((prev) => ({ ...prev, check_out: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">상태</label>
            <select
              className="input-base"
              value={editForm.status}
              onChange={(e) => setEditForm((prev) => ({ ...prev, status: e.target.value }))}
            >
              <option value="present">출근</option>
              <option value="late">지각</option>
              <option value="absent">결근</option>
              <option value="leave">휴가</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">메모</label>
            <textarea
              className="input-base min-h-[88px]"
              value={editForm.note}
              onChange={(e) => setEditForm((prev) => ({ ...prev, note: e.target.value }))}
            />
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" className="btn-secondary flex-1" onClick={() => setEditRow(null)}>취소</button>
            <button type="submit" className="btn-primary flex-1" disabled={editSaving}>
              {editSaving ? '저장 중...' : '저장'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
