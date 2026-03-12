'use client';
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import DataTable from '@/components/DataTable';
import Link from 'next/link';

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
  const thisMonth = new Date().toISOString().slice(0, 7);
  const [yearMonth,    setYearMonth]  = useState(thisMonth);
  const [rows,         setRows]       = useState([]);
  const [summary,      setSummary]    = useState(null);
  const [loading,      setLoading]    = useState(true);
  const [calculating,  setCalc]       = useState(false);
  const [selected,     setSelected]   = useState(null);
  const [empCount,     setEmpCount]   = useState(null); // null=로딩중, 0=직원없음

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
          disabled={calculating || empCount === 0}
          title={empCount === 0 ? '재직 직원이 없습니다' : ''}
        >
          {calculating ? '계산 중...' : '급여 계산 실행'}
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

      <DetailModal row={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
