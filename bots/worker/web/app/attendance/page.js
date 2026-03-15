'use client';
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import DataTable from '@/components/DataTable';
import { useAuth } from '@/lib/auth-context';
import Modal from '@/components/Modal';
import { canPerformMenuOperation } from '@/lib/menu-access';
import PendingReviewSection from '@/components/PendingReviewSection';

function fmtTime(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
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
  const [date, setDate]           = useState(new Date().toISOString().slice(0,10));
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

  const load = () => {
    setLoading(true);
    api.get(`/attendance?date=${date}`).then(d => setRecords(d.attendance || [])).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [date]);

  const createProposal = async (payload) => {
    setProposalLoading(true);
    setError('');
    setNotice('');
    try {
      const data = await api.post('/attendance/proposals', payload);
      setProposal(data.proposal || null);
      setOriginalProposal(data.proposal || null);
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
  const columns = [
    { key: 'employee_name', label: '이름' },
    { key: 'check_in',      label: '출근', render: v => fmtTime(v) },
    { key: 'check_out',     label: '퇴근', render: v => fmtTime(v) },
    { key: 'status',        label: '상태', render: v => ({
      present: '✅ 출근', late: '⚠️ 지각', absent: '❌ 결근', leave: '🏖️ 휴가',
    }[v] || v) },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-gray-900">⏰ 근태 관리</h1>

      <div className="card space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-slate-500">근태 공용 프롬프트</p>
            <p className="text-sm text-slate-600 mt-1">
              출근, 퇴근, 휴가, 근태 현황 요청을 하나의 프롬프트 창에서 처리합니다.
            </p>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
            Noah 근태 {user?.role === 'master' ? '오케스트레이터' : user?.role === 'admin' ? '운영 에이전트' : '에이전트'}
          </span>
        </div>

        <div className="flex flex-wrap gap-2">
          {['출근했어요', '퇴근합니다', '내일 연차 신청', '오늘 오전 9시 출근으로 수정해줘'].map((item) => (
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
            placeholder="출근, 퇴근, 연차, 반차, 외근 요청을 자연어로 입력하세요."
          />
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className="btn-primary"
              onClick={handlePromptSubmit}
              disabled={proposalLoading || !prompt.trim()}
            >
              {proposalLoading ? '제안 생성 중...' : '확인 결과 만들기'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={handleCheckIn}
              disabled={!canCreateTodayOnly || proposalLoading || !!checking}
            >
              {checking === 'in' ? '처리 중...' : '지금 출근 제안'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={handleCheckOut}
              disabled={!canCreateTodayOnly || proposalLoading || !!checking}
            >
              {checking === 'out' ? '처리 중...' : '지금 퇴근 제안'}
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

      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        {!isMember && (
          <div className="card">
            <p className="text-sm font-medium text-slate-500">오늘의 근태 요약</p>
            <div className="grid gap-3 sm:grid-cols-3 mt-4">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                <p className="text-xs text-slate-500">출근 완료</p>
                <p className="text-2xl font-semibold text-slate-900 mt-1">{checkedIn}명</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                <p className="text-xs text-slate-500">퇴근 완료</p>
                <p className="text-2xl font-semibold text-slate-900 mt-1">{checkedOut}명</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                <p className="text-xs text-slate-500">지각</p>
                <p className="text-2xl font-semibold text-slate-900 mt-1">{lateCount}명</p>
              </div>
            </div>
          </div>
        )}

        <div className="card">
          <p className="text-sm font-medium text-slate-500">{isMember ? '내 근태 빠른 실행' : '빠른 실행'}</p>
          <div className="grid grid-cols-2 gap-3 mt-4">
            <button
              className="btn-primary h-16 text-base gap-2"
              onClick={handleCheckIn}
              disabled={!!checking}
            >
              <span className="text-2xl">🟢</span>
              {checking === 'in' ? '처리 중...' : '출근 제안'}
            </button>
            <button
              className="btn-secondary h-16 text-base gap-2"
              onClick={handleCheckOut}
              disabled={!!checking || proposalLoading}
            >
              <span className="text-2xl">🔴</span>
              {checking === 'out' ? '처리 중...' : '퇴근 제안'}
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-3">
            버튼을 누르면 바로 저장하지 않고, 먼저 확인 결과 창을 띄웁니다.
          </p>
        </div>
      </div>

      {/* 날짜 선택 + 통계 */}
      <div className="card flex flex-col sm:flex-row items-start sm:items-center gap-4">
        <div>
          <label className="text-sm font-medium text-slate-700 block mb-1">조회 날짜</label>
          <input
            type="date"
            className="input-base w-auto"
            value={date}
            onChange={e => setDate(e.target.value)}
          />
        </div>
        <div className="flex gap-4 text-sm">
          <div><span className="text-slate-500">{isMember ? '내 출근 기록' : '총 출근'}</span> <strong>{checkedIn}명</strong></div>
          <div><span className="text-slate-500">{isMember ? '내 기록 수' : '전체'}</span> <strong>{records.length}{isMember ? '건' : '명'}</strong></div>
        </div>
      </div>

      <div className="card">
        {loading
          ? <p className="text-center py-10 text-gray-400">로딩 중...</p>
          : <DataTable
              columns={columns}
              data={records}
              pageSize={10}
              emptyText="근태 기록 없음"
              actions={canManageAttendance ? (row) => (
                <>
                  <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => openEdit(row)}>수정</button>
                  <button className="btn-danger text-xs px-3 py-1.5" onClick={() => handleDeleteRecord(row)}>삭제</button>
                </>
              ) : undefined}
            />
        }
      </div>

      {(proposal || leaveProposal) && (
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
                  <label className="space-y-1 md:col-span-2">
                    <span className="text-xs font-semibold text-slate-500">메모</span>
                    <textarea
                      className="input-base min-h-[88px]"
                      value={proposal.note || ''}
                      onChange={(e) => setProposal((prev) => ({
                        ...prev,
                        note: e.target.value,
                      }))}
                      placeholder="필요하면 메모를 남길 수 있습니다."
                    />
                  </label>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-700">
                  <p><span className="font-semibold text-slate-900">대상</span> {proposal.employee_name}</p>
                  <p className="mt-1"><span className="font-semibold text-slate-900">예정 기록</span> {proposal.summary}</p>
                  <p className="mt-1"><span className="font-semibold text-slate-900">피드백 수집</span> 승인 시 품질이 좋았는지, 수정 후 승인했는지 자동 기록됩니다.</p>
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
                    {proposalLoading ? '확정 중...' : '이대로 확정'}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={handleRejectProposal}
                    disabled={proposalLoading}
                  >
                    제안 반려
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      setProposal(null);
                      setOriginalProposal(null);
                      setError('');
                    }}
                    disabled={proposalLoading}
                  >
                    닫기
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
                  <div className="flex flex-col gap-2 text-right">
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
                  <label className="space-y-1 md:col-span-2">
                    <span className="text-xs font-semibold text-slate-500">사유</span>
                    <textarea
                      className="input-base min-h-[88px]"
                      value={leaveProposal.reason || ''}
                      onChange={(e) => setLeaveProposal((prev) => ({
                        ...prev,
                        reason: e.target.value,
                      }))}
                      placeholder="휴가 사유를 입력하세요."
                    />
                  </label>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-700">
                  <p><span className="font-semibold text-slate-900">신청자</span> {leaveProposal.employee_name}</p>
                  <p className="mt-1"><span className="font-semibold text-slate-900">신청 내용</span> {leaveProposal.summary}</p>
                  <p className="mt-1"><span className="font-semibold text-slate-900">처리 방식</span> 접수 후 관리자 승인 대기 상태로 넘어갑니다.</p>
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
                    {proposalLoading ? '접수 중...' : '이대로 신청 접수'}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={handleRejectLeaveProposal}
                    disabled={proposalLoading}
                  >
                    제안 반려
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      setLeaveProposal(null);
                      setOriginalLeaveProposal(null);
                      setError('');
                    }}
                    disabled={proposalLoading}
                  >
                    닫기
                  </button>
                </div>
              </div>
            )}
          </div>
        </PendingReviewSection>
      )}

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
