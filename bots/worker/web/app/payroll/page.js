'use client';
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import DataTable from '@/components/DataTable';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { canPerformMenuOperation } from '@/lib/menu-access';
import PendingReviewSection from '@/components/PendingReviewSection';
import ProposalFlowActions from '@/components/ProposalFlowActions';

const PERF_COLORS = {
  S: 'bg-purple-100 text-purple-700',
  A: 'bg-blue-100 text-blue-700',
  B: 'bg-green-100 text-green-700',
  C: 'bg-yellow-100 text-yellow-700',
  D: 'bg-red-100 text-red-700',
};

const STATUS_LABEL = {
  draft:     '초안',
  confirmed: '확정',
  paid:      '지급완료',
};

function fmtWon(n) { return `₩${Number(n || 0).toLocaleString()}`; }
function fmtMonth(ym) {
  if (!ym) return '-';
  const [year, month] = String(ym).split('-');
  return `${year}년 ${Number(month)}월`;
}

function proposalChanged(original, proposal) {
  if (!original || !proposal) return false;
  return ['year_month'].some((key) => (original[key] || '') !== (proposal[key] || ''));
}

function DetailModal({ row, onClose }) {
  if (!row) return null;
  const detail = row.deduction_detail ? (typeof row.deduction_detail === 'string' ? JSON.parse(row.deduction_detail) : row.deduction_detail) : {};
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-3" onClick={e => e.stopPropagation()}>
        <h3 className="font-bold text-gray-900 text-lg">💰 급여 명세서</h3>
        <p className="text-sm text-gray-500">{row.employee_name ?? row.employee} · {row.year_month}</p>

        <div className="divide-y text-sm">
          <div className="flex justify-between py-2">
            <span className="text-gray-600">기본급</span>
            <span className="font-medium">{fmtWon(row.base_salary)}</span>
          </div>
          {Number(row.overtime_pay) > 0 && (
            <div className="flex justify-between py-2">
              <span className="text-gray-600">야근수당</span>
              <span className="font-medium">{fmtWon(row.overtime_pay)}</span>
            </div>
          )}
          {Number(row.incentive) > 0 && (
            <div className="flex justify-between py-2">
              <span className="text-gray-600">인센티브</span>
              <span className="font-medium">{fmtWon(row.incentive)}</span>
            </div>
          )}
          <div className="flex justify-between py-2">
            <span className="font-semibold text-gray-800">과세 소득</span>
            <span className="font-semibold">{fmtWon(Number(row.base_salary || 0) + Number(row.overtime_pay || 0) + Number(row.incentive || 0))}</span>
          </div>
          {Object.entries(detail).map(([k, v]) => (
            <div key={k} className="flex justify-between py-1.5 text-red-600">
              <span>{k}</span>
              <span>-{fmtWon(v)}</span>
            </div>
          ))}
          <div className="flex justify-between py-2 text-lg font-bold text-indigo-700">
            <span>실수령액</span>
            <span>{fmtWon(row.net_salary)}</span>
          </div>
        </div>

        <div className="flex gap-2 text-xs pt-1">
          <span className="text-gray-500">근무: {row.work_days}일</span>
          <span className="text-gray-500">지각: {row.late_count}회</span>
          <span className="text-gray-500">결근: {row.absent_count}일</span>
          {row.performance && (
            <span className={`ml-auto px-2 py-0.5 rounded-full font-bold ${PERF_COLORS[row.performance] || ''}`}>
              {row.performance}등급
            </span>
          )}
        </div>
        <button className="btn-secondary w-full mt-2" onClick={onClose}>닫기</button>
      </div>
    </div>
  );
}

export default function PayrollPage() {
  const { user } = useAuth();
  const canManage = canPerformMenuOperation(user, 'payroll', 'create');
  const thisMonth = new Date().toISOString().slice(0, 7);
  const [yearMonth,    setYearMonth]  = useState(thisMonth);
  const [rows,         setRows]       = useState([]);
  const [summary,      setSummary]    = useState(null);
  const [loading,      setLoading]    = useState(true);
  const [calculating,  setCalc]       = useState(false);
  const [selected,     setSelected]   = useState(null);
  const [empCount,     setEmpCount]   = useState(null); // null=로딩중, 0=직원없음
  const [prompt, setPrompt] = useState('');
  const [proposal, setProposal] = useState(null);
  const [originalProposal, setOriginalProposal] = useState(null);
  const [proposalLoading, setProposalLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const refillPrompt = (text) => {
    setPrompt(text);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const load = () => {
    setLoading(true);
    Promise.all([
      api.get(`/payroll?year_month=${yearMonth}`).catch(() => ({ payroll: [] })),
      api.get(`/payroll/summary?year_month=${yearMonth}`).catch(() => null),
      api.get('/employees').catch(() => ({ employees: [] })),
    ]).then(([p, s, e]) => {
      setRows(p.payroll || []);
      setSummary(s);
      setEmpCount((e.employees || []).filter(emp => emp.status === 'active').length);
    }).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [yearMonth]);

  const createProposal = async () => {
    if (!prompt.trim()) return;
    setProposalLoading(true);
    setError('');
    setNotice('');
    try {
      const data = await api.post('/payroll/proposals', { prompt });
      setProposal(data.proposal || null);
      setOriginalProposal(data.proposal || null);
      setPrompt('');
    } catch (e) {
      setError(e.message);
    } finally {
      setProposalLoading(false);
    }
  };

  const handleCalculate = async () => {
    if (!confirm(`${yearMonth} 급여를 계산하시겠습니까?`)) return;
    setCalc(true);
    try {
      const res = await api.post('/payroll/calculate', { year_month: yearMonth });
      alert(res.message || '급여 계산 완료');
      load();
    } catch (e) { alert(e.message); }
    finally { setCalc(false); }
  };

  const handleConfirmProposal = async () => {
    if (!proposal?.feedback_session_id) return;
    setProposalLoading(true);
    setError('');
    try {
      const res = await api.post(`/payroll/proposals/${proposal.feedback_session_id}/confirm`, { proposal });
      setNotice(res.message || `${proposal.year_month} 급여 계산을 확정했습니다.`);
      setProposal(null);
      setOriginalProposal(null);
      setYearMonth(proposal.year_month);
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
      await api.post(`/payroll/proposals/${proposal.feedback_session_id}/reject`, {});
      setNotice('급여 계산 제안을 반려했습니다.');
      setProposal(null);
      setOriginalProposal(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setProposalLoading(false);
    }
  };

  const columns = [
    { key: 'employee_name', label: '직원명' },
    { key: 'base_salary',   label: '기본급',   render: fmtWon },
    { key: 'overtime_pay',  label: '야근수당', render: fmtWon },
    { key: 'incentive',     label: '인센티브', render: fmtWon },
    { key: 'deduction',     label: '공제 합계', render: v => <span className="text-red-600">-{fmtWon(v)}</span> },
    { key: 'net_salary',    label: '실수령액',  render: v => <span className="font-bold text-indigo-700">{fmtWon(v)}</span> },
    { key: 'performance',   label: '성과',      render: v => v ? <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${PERF_COLORS[v] || ''}`}>{v}</span> : '-' },
    { key: 'status',        label: '상태',      render: v => STATUS_LABEL[v] || v },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-gray-900">💰 급여 관리</h1>

      {canManage && (
        <div className="card space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-slate-500">급여 자연어 실행</p>
              <p className="text-sm text-slate-600 mt-1">
                예: `이번 달 급여 계산해줘`, `2026년 2월 급여 계산 다시 해줘`
              </p>
            </div>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
              확인 결과 창 기반 피드백 수집
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            {['이번 달 급여 계산해줘', '지난달 급여 다시 계산해줘', '2026년 2월 급여 계산해줘'].map((item) => (
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
              placeholder="급여 계산 요청을 자연어로 입력하세요."
            />
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className="btn-primary"
                onClick={createProposal}
                disabled={!canManage || proposalLoading || !prompt.trim()}
              >
                {proposalLoading ? '제안 생성 중...' : '급여 제안 만들기'}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={handleCalculate}
                disabled={!canManage || calculating || empCount === 0}
              >
                직접 계산 실행
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
      )}

      {/* 월 선택 + 계산 버튼 */}
      <div className="card flex flex-col sm:flex-row items-start sm:items-center gap-4">
        <div>
          <label className="text-sm font-medium text-gray-700 block mb-1">대상 월</label>
          <input
            type="month"
            className="input-base w-auto"
            value={yearMonth}
            onChange={e => setYearMonth(e.target.value)}
          />
        </div>
        <button
          className="btn-primary sm:mt-5 disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={handleCalculate}
          disabled={!canManage || calculating || empCount === 0}
          title={empCount === 0 ? '재직 직원이 없습니다' : ''}
        >
          {calculating ? '계산 중...' : canManage ? '급여 계산 실행' : '관리자 전용'}
        </button>
        {summary && (
          <div className="flex gap-4 text-sm sm:ml-auto">
            <div><span className="text-gray-500">직원 수</span> <strong>{summary.count}명</strong></div>
            <div><span className="text-gray-500">총 지급</span> <strong className="text-indigo-700">{fmtWon(summary.total_net)}</strong></div>
            <div><span className="text-gray-500">총 공제</span> <strong className="text-red-600">{fmtWon(summary.total_deduction)}</strong></div>
          </div>
        )}
      </div>

      {/* 직원 없음 안내 */}
      {empCount === 0 && !loading && (
        <div className="card bg-amber-50 border border-amber-200 flex items-start gap-3 p-4">
          <span className="text-xl">⚠️</span>
          <div>
            <p className="font-medium text-amber-800">재직 직원이 없습니다</p>
            <p className="text-sm text-amber-700 mt-1">
              급여 계산을 하려면 먼저{' '}
              <Link href="/employees" className="underline font-medium">직원 관리</Link>에서
              직원을 등록하고 기본급을 설정해야 합니다.
            </p>
          </div>
        </div>
      )}

      {!canManage && (
        <div className="card bg-slate-50 border border-slate-200 text-sm text-slate-600">
          멤버 등급은 급여 현황 조회만 가능합니다. 급여 계산이나 수정은 관리자 또는 마스터에게 요청하세요.
        </div>
      )}

      {/* 테이블 */}
      <div className="card">
        {loading ? (
          <p className="text-center py-10 text-gray-400">로딩 중...</p>
        ) : (
          <DataTable
              pageSize={10}
            columns={columns}
            data={rows}
            emptyText={`${yearMonth} 급여 데이터 없음 — 위 버튼으로 계산하세요`}
            onRowClick={row => setSelected(row)}
          />
        )}
      </div>

      {(proposal || notice) && (
        <PendingReviewSection
          hasPending={Boolean(proposal)}
          description="급여 계산 제안을 아래 리스트에서 검토하고 실행하거나 반려합니다."
        >
          {proposal && (
            <div className="rounded-2xl border border-sky-200 bg-sky-50/40 px-4 py-4 space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-sky-700">급여 계산 제안</p>
                  <h2 className="text-lg font-semibold text-slate-900 mt-1">{proposal.summary}</h2>
                  <p className="text-sm text-slate-600 mt-1">
                    자연어 입력을 급여 계산 제안으로 해석했습니다. 대상 월을 확인한 뒤 계산을 실행하세요.
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
                  <span className="text-xs font-semibold text-slate-500">작업</span>
                  <input className="input-base bg-slate-50" value={proposal.action_label || '급여 계산'} disabled />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-semibold text-slate-500">대상 월</span>
                  <input
                    type="month"
                    className="input-base"
                    value={proposal.year_month || ''}
                    onChange={(e) => setProposal((prev) => ({
                      ...prev,
                      year_month: e.target.value,
                      summary: `${e.target.value} 급여 계산 제안`,
                    }))}
                  />
                </label>
              </div>

              {Array.isArray(proposal.similar_cases) && proposal.similar_cases.length > 0 && (
                <div className="rounded-2xl border border-violet-200 bg-violet-50/70 px-4 py-4">
                  <p className="text-sm font-semibold text-violet-900">유사 확정 사례</p>
                  <div className="mt-3 space-y-2">
                    {proposal.similar_cases.map((item) => (
                      <div key={item.id} className="rounded-xl border border-violet-100 bg-white/90 px-3 py-3 text-sm text-slate-700">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-medium text-slate-900">{item.summary || '유사 급여 계산 사례'}</p>
                          <span className="rounded-full bg-violet-100 px-2 py-1 text-[11px] font-semibold text-violet-700">
                            유사도 {(item.similarity * 100).toFixed(0)}%
                          </span>
                        </div>
                        <p className="mt-2 text-xs text-slate-600 whitespace-pre-wrap">{item.preview}</p>
                        <button
                          type="button"
                          className="mt-3 rounded-full border border-violet-200 bg-violet-100 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-200"
                          onClick={() => refillPrompt(`이 사례를 참고해서 ${proposal.year_month || yearMonth} 급여 계산 제안을 다시 정리해줘\n${item.preview || item.summary || ''}`.trim())}
                        >
                          이 사례로 다시 작성
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="rounded-2xl border border-slate-200 bg-white/90 px-4 py-4 text-sm text-slate-700">
                <p className="font-medium text-slate-900">실행 안내</p>
                <p className="mt-1">
                  확정하면 <strong>{fmtMonth(proposal.year_month)}</strong> 기준으로 재직 직원 급여를 다시 계산하고,
                  해당 월의 급여 테이블을 갱신합니다.
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                <ProposalFlowActions
                  onPromptFill={() => refillPrompt(`${proposal.year_month || yearMonth} 급여 계산 제안을 다시 정리해줘`)}
                  onSecondary={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
                />
                <button type="button" className="btn-primary" onClick={handleConfirmProposal} disabled={proposalLoading}>
                  {proposalLoading ? '확정 중...' : '이대로 계산 실행'}
                </button>
                <button type="button" className="btn-secondary" onClick={handleRejectProposal} disabled={proposalLoading}>
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
        </PendingReviewSection>
      )}

      <DetailModal row={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
