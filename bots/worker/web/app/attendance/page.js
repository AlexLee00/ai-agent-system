'use client';
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import DataTable from '@/components/DataTable';
import WorkerAIWorkspace from '@/components/WorkerAIWorkspace';

function fmtTime(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

export default function AttendancePage() {
  const [records, setRecords]     = useState([]);
  const [date, setDate]           = useState(new Date().toISOString().slice(0,10));
  const [loading, setLoading]     = useState(true);
  const [checking, setChecking]   = useState('');

  const load = () => {
    setLoading(true);
    api.get(`/attendance?date=${date}`).then(d => setRecords(d.attendance || [])).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [date]);

  const handleCheckIn = async () => {
    setChecking('in');
    try { await api.post('/attendance/checkin', {}); load(); alert('출근 체크 완료!'); }
    catch (e) { alert(e.message); }
    finally { setChecking(''); }
  };

  const handleCheckOut = async () => {
    setChecking('out');
    try { await api.post('/attendance/checkout', {}); load(); alert('퇴근 체크 완료!'); }
    catch (e) { alert(e.message); }
    finally { setChecking(''); }
  };

  const checkedIn  = records.filter(r => r.check_in).length;
  const checkedOut = records.filter(r => r.check_out).length;
  const lateCount = records.filter(r => r.status === 'late').length;
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
      <WorkerAIWorkspace
        title="근태 AI 업무대화"
        description="출근 현황, 휴가, 직원 요청을 대화로 처리하고 결과를 캔버스에서 바로 확인합니다."
        suggestions={['오늘 근태 현황 보여줘', '오늘 출근 안 한 직원 알려줘', '이번 주 휴가자 정리해줘']}
        allowUpload
      />
      <h1 className="text-xl font-bold text-gray-900">⏰ 근태 관리</h1>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
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

        <div className="card">
          <p className="text-sm font-medium text-slate-500">빠른 실행</p>
          <div className="grid grid-cols-2 gap-3 mt-4">
            <button
              className="btn-primary h-16 text-base gap-2"
              onClick={handleCheckIn}
              disabled={!!checking}
            >
              <span className="text-2xl">🟢</span>
              {checking === 'in' ? '처리 중...' : '출근 체크'}
            </button>
            <button
              className="btn-secondary h-16 text-base gap-2"
              onClick={handleCheckOut}
              disabled={!!checking}
            >
              <span className="text-2xl">🔴</span>
              {checking === 'out' ? '처리 중...' : '퇴근 체크'}
            </button>
          </div>
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
          <div><span className="text-slate-500">총 출근</span> <strong>{checkedIn}명</strong></div>
          <div><span className="text-slate-500">전체</span> <strong>{records.length}명</strong></div>
        </div>
      </div>

      <div className="card">
        {loading
          ? <p className="text-center py-10 text-gray-400">로딩 중...</p>
          : <DataTable columns={columns} data={records} pageSize={10} emptyText="근태 기록 없음" />
        }
      </div>
    </div>
  );
}
