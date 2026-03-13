'use client';
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';

const STATUS_LABELS = { pending: '대기', approved: '승인', rejected: '반려' };
const STATUS_COLORS = {
  pending:  'bg-yellow-100 text-yellow-800',
  approved: 'bg-green-100  text-green-800',
  rejected: 'bg-red-100    text-red-800',
};

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [processing, setProc]     = useState(null);

  const load = () => {
    setLoading(true);
    api.get('/approvals').then(d => setApprovals(d.approvals || [])).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const handleApprove = async (id) => {
    setProc(id);
    try { await api.put(`/approvals/${id}/approve`); load(); }
    catch (e) { alert(e.message); }
    finally { setProc(null); }
  };

  const handleReject = async (id) => {
    const reason = prompt('반려 사유를 입력하세요:');
    if (!reason) return;
    setProc(id);
    try { await api.put(`/approvals/${id}/reject`, { reason }); load(); }
    catch (e) { alert(e.message); }
    finally { setProc(null); }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-gray-900">✅ 승인 관리</h1>

      {loading ? (
        <p className="text-center py-20 text-gray-400">로딩 중...</p>
      ) : approvals.length === 0 ? (
        <div className="card text-center py-12 text-gray-400">
          <p className="text-4xl mb-2">✅</p>
          <p>대기 중인 승인 요청 없음</p>
        </div>
      ) : (
        <div className="space-y-3">
          {approvals.map(a => {
            const payload = typeof a.payload === 'string' ? JSON.parse(a.payload) : (a.payload || {});
            return (
              <div key={a.id} className="card">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[a.status]}`}>
                        {STATUS_LABELS[a.status]}
                      </span>
                      <span className="text-xs text-gray-500">#{a.id}</span>
                      <span className="text-xs text-gray-500">
                        {a.priority === 'urgent' ? '🚨 긴급' : '📋 일반'}
                      </span>
                    </div>
                    <p className="font-medium text-gray-900">{a.action}</p>
                    <p className="text-sm text-gray-500">신청자: {a.requester_name || a.requester_id}</p>
                    {a.task_title && (
                      <p className="text-sm text-gray-500">업무: {a.task_title} ({a.target_bot || 'unknown'})</p>
                    )}
                    {payload.date   && <p className="text-sm text-gray-500">날짜: {payload.date}</p>}
                    {payload.reason && <p className="text-sm text-gray-500">사유: {payload.reason}</p>}
                    <p className="text-xs text-gray-400 mt-1">{new Date(a.created_at).toLocaleString('ko-KR')}</p>
                  </div>

                  {a.status === 'pending' && (
                    <div className="flex flex-col gap-2 shrink-0">
                      <button
                        className="btn-primary text-sm px-4 py-2"
                        disabled={processing === a.id}
                        onClick={() => handleApprove(a.id)}
                      >
                        ✅ 승인
                      </button>
                      <button
                        className="btn-danger text-sm px-4 py-2"
                        disabled={processing === a.id}
                        onClick={() => handleReject(a.id)}
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
