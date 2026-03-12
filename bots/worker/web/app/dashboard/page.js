'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import Card from '@/components/Card';
import { SalesBarChart } from '@/components/Chart';

const WEEKDAY = ['일','월','화','수','목','금','토'];

const ACTIVITY_ICONS = {
  journal:    '📝',
  attendance: '👤',
  sales:      '💰',
  approval:   '✅',
};

function timeAgo(ts) {
  const diff  = Date.now() - new Date(ts).getTime();
  const mins  = Math.floor(diff / 60000);
  if (mins < 1)  return '방금';
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

export default function DashboardPage() {
  const router = useRouter();
  const [summary,      setSummary]      = useState(null);
  const [salesData,    setSalesData]    = useState([]);
  const [monthlyData,  setMonthlyData]  = useState([]);
  const [activity,     setActivity]     = useState([]);
  const [loading,      setLoading]      = useState(true);

  useEffect(() => {
    Promise.all([
      api.get('/dashboard/summary').catch(() => null),
      api.get('/sales/summary').catch(() => null),
      api.get('/activity').catch(() => null),
    ]).then(([sum, sales, act]) => {
      if (sum) setSummary(sum);
      if (sales?.weekly) {
        const map = Object.fromEntries((sales.weekly).map(r => [r.date.slice(0,10), Number(r.total)]));
        const rows = [];
        for (let i = 6; i >= 0; i--) {
          const d = new Date(); d.setDate(d.getDate() - i);
          const key = d.toISOString().slice(0,10);
          rows.push({ label: `${d.getMonth()+1}/${d.getDate()}(${WEEKDAY[d.getDay()]})`, total: map[key] ?? 0 });
        }
        setSalesData(rows);
      }
      if (sales?.daily30) {
        const map = Object.fromEntries((sales.daily30).map(r => [r.date.slice(0,10), Number(r.total)]));
        const rows = [];
        for (let i = 29; i >= 0; i--) {
          const d = new Date(); d.setDate(d.getDate() - i);
          const key = d.toISOString().slice(0,10);
          rows.push({ label: `${d.getMonth()+1}/${d.getDate()}`, total: map[key] ?? 0 });
        }
        setMonthlyData(rows);
      }
      if (act?.activities) setActivity(act.activities);
    }).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-center py-20 text-gray-400">로딩 중...</div>;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-gray-900">대시보드</h1>

      {/* 요약 카드 */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <Card
          title="오늘 매출"
          value={`₩${(summary?.today_sales ?? 0).toLocaleString()}`}
          icon="💰"
          color="blue"
          onClick={() => router.push('/sales')}
        />
        <Card
          title="출근 인원"
          value={`${summary?.checked_in ?? 0}명`}
          icon="👥"
          color="green"
          onClick={() => router.push('/attendance')}
        />
        <Card
          title="미처리 문서"
          value={`${summary?.pending_docs ?? 0}건`}
          icon="📋"
          color="yellow"
          onClick={() => router.push('/documents')}
        />
        <Card
          title="대기 승인"
          value={`${summary?.pending_approvals ?? 0}건`}
          icon="✅"
          color="red"
          onClick={() => router.push('/approvals')}
        />
        <Card
          title="진행 중 프로젝트"
          value={`${summary?.active_projects ?? 0}건`}
          icon="📋"
          color="blue"
          onClick={() => router.push('/projects')}
        />
        <Card
          title="오늘 일정"
          value={`${summary?.today_schedules ?? 0}건`}
          icon="📅"
          color="green"
          onClick={() => router.push('/schedules')}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 월간 매출 차트 */}
        <div className="card lg:col-span-2">
          <h2 className="font-semibold text-gray-800 mb-4">📈 월간 매출 (최근 30일)</h2>
          {monthlyData.length > 0 ? (
            <SalesBarChart data={monthlyData} />
          ) : (
            <div className="text-center py-10">
              <p className="text-4xl mb-3">📈</p>
              <p className="text-gray-500 text-sm">매출 데이터가 없습니다</p>
            </div>
          )}
        </div>

        {/* 최근 활동 — 월간·주간 옆에 row-span-2 */}
        <div className="card lg:row-span-2">
          <h2 className="font-semibold text-gray-800 mb-4">📋 최근 활동</h2>
          {activity.length === 0 ? (
            <p className="text-center text-gray-400 text-sm py-6">활동 내역 없음</p>
          ) : (
            <div className="relative">
              <div className="absolute left-3.5 top-0 bottom-0 w-px bg-gray-100" />
              <div className="space-y-4">
                {activity.map((item, i) => (
                  <div key={i} className="flex gap-3 items-start relative">
                    <div className="w-7 h-7 rounded-full bg-indigo-50 flex items-center justify-center text-sm shrink-0 z-10">
                      {ACTIVITY_ICONS[item.type] || '🔔'}
                    </div>
                    <div className="flex-1 min-w-0 pt-0.5">
                      <p className="text-sm text-gray-700 leading-snug">{item.detail}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{timeAgo(item.created_at)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 주간 매출 차트 */}
        <div className="card lg:col-span-2">
          <h2 className="font-semibold text-gray-800 mb-4">📊 주간 매출 (최근 7일)</h2>
          {salesData.length > 0 ? (
            <SalesBarChart data={salesData} />
          ) : (
            <div className="text-center py-10">
              <p className="text-4xl mb-3">📊</p>
              <p className="text-gray-500 text-sm mb-4">매출을 등록하면 차트가 표시됩니다</p>
              <Link href="/sales" className="inline-flex items-center gap-1 text-sm text-indigo-600 font-medium hover:underline">
                매출 등록하기 →
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
