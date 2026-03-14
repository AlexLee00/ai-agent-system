'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Users, Wallet, ArrowRight } from 'lucide-react';
import { api } from '@/lib/api';
import DataTable from '@/components/DataTable';

function StatCard({ title, value, description, icon: Icon, href }) {
  return (
    <Link href={href} className="card hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-slate-500">{title}</p>
          <p className="text-2xl font-semibold text-slate-900 mt-1">{value}</p>
          <p className="text-sm text-slate-500 mt-2">{description}</p>
        </div>
        <div className="w-11 h-11 rounded-2xl bg-slate-100 flex items-center justify-center text-slate-700">
          <Icon className="w-5 h-5" />
        </div>
      </div>
      <div className="mt-4 flex items-center gap-2 text-sm font-medium text-slate-700">
        바로 가기
        <ArrowRight className="w-4 h-4" />
      </div>
    </Link>
  );
}

export default function WorkforcePage() {
  const [tab, setTab] = useState('overview');
  const [employees, setEmployees] = useState([]);
  const [payrollRows, setPayrollRows] = useState([]);
  const [activeEmployees, setActiveEmployees] = useState(0);
  const [payrollCount, setPayrollCount] = useState(0);
  const [payrollMonth, setPayrollMonth] = useState(new Date().toISOString().slice(0, 7));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.get('/employees').catch(() => ({ employees: [] })),
      api.get(`/payroll?year_month=${payrollMonth}`).catch(() => ({ payroll: [] })),
    ]).then(([employeeData, payrollData]) => {
      const nextEmployees = employeeData.employees || [];
      const nextPayroll = payrollData.payroll || [];
      setEmployees(nextEmployees);
      setPayrollRows(nextPayroll);
      setActiveEmployees(nextEmployees.filter(item => item.status === 'active').length);
      setPayrollCount(nextPayroll.length);
    }).finally(() => setLoading(false));
  }, [payrollMonth]);

  const employeeColumns = [
    { key: 'name', label: '이름' },
    { key: 'department', label: '부서', render: (value) => value || '-' },
    { key: 'position', label: '직급', render: (value) => value || '-' },
    { key: 'base_salary', label: '기본급', render: (value) => value ? `₩${Number(value).toLocaleString()}` : '-' },
    {
      key: 'status',
      label: '상태',
      render: (value) => value === 'active'
        ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">재직</span>
        : <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">퇴직</span>,
    },
  ];

  const payrollColumns = [
    { key: 'employee_name', label: '직원명' },
    { key: 'base_salary', label: '기본급', render: (value) => `₩${Number(value || 0).toLocaleString()}` },
    { key: 'deduction', label: '공제', render: (value) => <span className="text-rose-600">₩{Number(value || 0).toLocaleString()}</span> },
    { key: 'net_salary', label: '실수령액', render: (value) => <span className="font-semibold text-slate-900">₩{Number(value || 0).toLocaleString()}</span> },
    {
      key: 'status',
      label: '상태',
      render: (value) => {
        const label = value === 'paid' ? '지급완료' : value === 'confirmed' ? '확정' : '초안';
        const style = value === 'paid'
          ? 'bg-emerald-100 text-emerald-700'
          : value === 'confirmed'
            ? 'bg-sky-100 text-sky-700'
            : 'bg-slate-100 text-slate-600';
        return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${style}`}>{label}</span>;
      },
    },
  ];

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-xl font-bold text-slate-900">관리자 인사 운영</h1>
        <p className="text-sm text-slate-500">직원 정보와 급여 관리를 하나의 관리 영역에서 다룹니다.</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <StatCard
          title="직원 관리"
          value={`${activeEmployees}명`}
          description="재직 직원 현황, 부서, 직급, 기본급을 관리합니다."
          icon={Users}
          href="/employees"
        />
        <StatCard
          title="급여 관리"
          value={`${payrollCount}건`}
          description={`${payrollMonth} 기준 급여 계산과 명세서를 관리합니다.`}
          icon={Wallet}
          href="/payroll"
        />
      </div>

      <div className="flex gap-1 bg-slate-100 p-1 rounded-2xl w-fit">
        {[
          { key: 'overview', label: '개요' },
          { key: 'employees', label: '직원' },
          { key: 'payroll', label: '급여' },
        ].map(item => (
          <button
            key={item.key}
            onClick={() => setTab(item.key)}
            className={`px-4 py-2 text-sm rounded-2xl font-medium transition-colors ${
              tab === item.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="card">
        <div className="flex flex-wrap items-center gap-3 justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-900">운영 바로가기</h2>
            <p className="text-sm text-slate-500 mt-1">주요 관리자 업무를 빠르게 이동할 수 있습니다.</p>
          </div>
          <input
            type="month"
            className="input-base w-auto"
            value={payrollMonth}
            onChange={(e) => setPayrollMonth(e.target.value)}
          />
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Link href="/employees" className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 hover:bg-white transition-colors">
            <p className="font-medium text-slate-900">직원 등록 및 수정</p>
            <p className="text-sm text-slate-500 mt-1">직원, 부서, 직급, 연락처, 기본급</p>
          </Link>
          <Link href="/payroll" className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 hover:bg-white transition-colors">
            <p className="font-medium text-slate-900">급여 계산 및 명세</p>
            <p className="text-sm text-slate-500 mt-1">월별 계산, 공제, 실수령액 확인</p>
          </Link>
        </div>
      </div>

      {tab === 'overview' && (
        <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="card">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">직원 현황 미리보기</h2>
                <p className="text-sm text-slate-500 mt-1">활성 직원 중심으로 최신 정보를 바로 확인합니다.</p>
              </div>
              <Link href="/employees" className="text-sm font-medium text-slate-700 hover:text-slate-900">
                전체 보기
              </Link>
            </div>
            {loading ? (
              <p className="text-sm text-slate-400 py-8 text-center">직원 정보를 불러오는 중...</p>
            ) : (
              <DataTable
                columns={employeeColumns}
                data={employees.slice(0, 5)}
                pageSize={5}
                emptyText="등록된 직원이 없습니다."
              />
            )}
          </div>

          <div className="card">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">급여 현황 미리보기</h2>
                <p className="text-sm text-slate-500 mt-1">{payrollMonth} 기준 계산 결과를 한눈에 확인합니다.</p>
              </div>
              <Link href="/payroll" className="text-sm font-medium text-slate-700 hover:text-slate-900">
                전체 보기
              </Link>
            </div>
            {loading ? (
              <p className="text-sm text-slate-400 py-8 text-center">급여 정보를 불러오는 중...</p>
            ) : (
              <DataTable
                columns={payrollColumns}
                data={payrollRows.slice(0, 5)}
                pageSize={5}
                emptyText="해당 월 급여 데이터가 없습니다."
              />
            )}
          </div>
        </div>
      )}

      {tab === 'employees' && (
        <div className="card">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">직원 목록</h2>
              <p className="text-sm text-slate-500 mt-1">기본급, 부서, 재직 상태를 여기서 빠르게 검토할 수 있습니다.</p>
            </div>
            <Link href="/employees" className="btn-secondary text-sm">직원 관리 열기</Link>
          </div>
          {loading ? (
            <p className="text-sm text-slate-400 py-8 text-center">직원 정보를 불러오는 중...</p>
          ) : (
            <DataTable
              columns={employeeColumns}
              data={employees}
              pageSize={10}
              emptyText="등록된 직원이 없습니다."
            />
          )}
        </div>
      )}

      {tab === 'payroll' && (
        <div className="card">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">급여 목록</h2>
              <p className="text-sm text-slate-500 mt-1">{payrollMonth} 기준 급여 계산 결과와 지급 상태를 확인합니다.</p>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="month"
                className="input-base w-auto"
                value={payrollMonth}
                onChange={(e) => setPayrollMonth(e.target.value)}
              />
              <Link href="/payroll" className="btn-secondary text-sm">급여 관리 열기</Link>
            </div>
          </div>
          {loading ? (
            <p className="text-sm text-slate-400 py-8 text-center">급여 정보를 불러오는 중...</p>
          ) : (
            <DataTable
              columns={payrollColumns}
              data={payrollRows}
              pageSize={10}
              emptyText="해당 월 급여 데이터가 없습니다."
            />
          )}
        </div>
      )}
    </div>
  );
}
