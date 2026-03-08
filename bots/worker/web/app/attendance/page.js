'use client';
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import DataTable from '@/components/DataTable';

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

      {/* 출퇴근 버튼 (큰 터치 영역) */}
      <div className="grid grid-cols-2 gap-4">
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

      {/* 날짜 선택 + 통계 */}
      <div className="card flex flex-col sm:flex-row items-start sm:items-center gap-4">
        <div>
          <label className="text-sm font-medium text-gray-700 block mb-1">조회 날짜</label>
          <input
            type="date"
            className="input-base w-auto"
            value={date}
            onChange={e => setDate(e.target.value)}
          />
        </div>
        <div className="flex gap-4 text-sm">
          <div><span className="text-gray-500">총 출근</span> <strong>{checkedIn}명</strong></div>
          <div><span className="text-gray-500">전체</span> <strong>{records.length}명</strong></div>
        </div>
      </div>

      <div className="card">
        {loading
          ? <p className="text-center py-10 text-gray-400">로딩 중...</p>
          : <DataTable columns={columns} data={records} emptyText="근태 기록 없음" />
        }
      </div>
    </div>
  );
}
