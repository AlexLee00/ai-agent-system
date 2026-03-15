'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import Card from '@/components/Card';
import { SalesBarChart } from '@/components/Chart';
import WorkerAIWorkspace from '@/components/WorkerAIWorkspace';
import { useAuth } from '@/lib/auth-context';

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
  const { user } = useAuth();
  const router = useRouter();
  const [summary,      setSummary]      = useState(null);
  const [alerts,       setAlerts]       = useState(null);
  const [salesData,    setSalesData]    = useState([]);
  const [monthlyData,  setMonthlyData]  = useState([]);
  const [activity,     setActivity]     = useState([]);
  const [loading,      setLoading]      = useState(true);
  const canUsePromptWorkspace = ['admin', 'master'].includes(user?.role);
  const isMember = user?.role === 'member';

  useEffect(() => {
    const requests = [
      api.get('/dashboard/summary').catch(() => null),
      api.get('/sales/summary').catch(() => null),
      api.get('/activity').catch(() => null),
      canUsePromptWorkspace ? api.get('/dashboard/alerts').catch(() => null) : Promise.resolve(null),
    ];

    Promise.all(requests).then(([sum, sales, act, alertData]) => {
      if (sum) setSummary(sum);
      if (alertData) setAlerts(alertData);
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
  }, [canUsePromptWorkspace]);

  if (loading) return <div className="text-center py-20 text-gray-400">로딩 중...</div>;

  const quickLinks = [
    { label: '근태 확인', desc: '오늘 출근 인원과 상태를 확인합니다.', href: '/attendance' },
    { label: '일정 등록', desc: '회의와 리마인더를 바로 추가합니다.', href: '/schedules' },
    { label: '업무 관리', desc: 'AI 대화와 문서 업로드를 시작합니다.', href: '/journals' },
    { label: '매출 입력', desc: '오늘 매출과 주간 흐름을 바로 기록합니다.', href: '/sales' },
  ];
  const uncheckedPreview = alerts?.unchecked_in_preview || [];
  const upcomingSchedules = alerts?.upcoming_schedules || [];

  return (
    <div className="space-y-6">
      {canUsePromptWorkspace && (
        <WorkerAIWorkspace
          menuKey="dashboard"
          title={user?.role === 'master' ? '마스터 대시보드 업무대화' : '관리자 대시보드 업무대화'}
          description={user?.role === 'master'
            ? '왼쪽 프롬프트창에서 자연어로 지시하고, 오른쪽 결과창에서 동적 캔버스와 최근 업무 큐를 확인합니다.'
            : '왼쪽 프롬프트창에서 운영 요청을 입력하고, 오른쪽 결과창에서 동적 렌더링과 처리 결과를 확인합니다.'}
          suggestions={user?.role === 'master'
            ? ['오늘 운영 현황 요약해줘', '미승인 업무 보여줘', '이번 주 매출 흐름 정리해줘']
            : ['오늘 미출근 직원 보여줘', '오늘 일정 요약해줘', '대기 승인 업무 보여줘']}
          allowUpload={false}
        />
      )}

      <section className="card overflow-hidden bg-gradient-to-br from-white to-slate-100/80">
        <div className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium text-slate-500">오늘의 운영 요약</p>
              <h1 className="text-2xl font-semibold text-slate-900 mt-1">워커 운영 대시보드</h1>
              <p className="text-sm text-slate-500 mt-2">
                {isMember
                  ? '내 업무와 운영 내역을 읽기 전용으로 빠르게 확인할 수 있습니다.'
                  : '프롬프트 입력과 운영 요약, 매출과 일정 상태를 한 번에 확인할 수 있습니다.'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="btn-primary text-sm" onClick={() => router.push('/journals')}>
                {isMember ? '업무 내역 열기' : '업무 관리 열기'}
              </button>
              <button className="btn-secondary text-sm" onClick={() => router.push('/schedules')}>
                일정 관리 열기
              </button>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-[1.25rem] border border-slate-200 bg-white px-4 py-4">
              <p className="text-sm text-slate-500">대기 승인</p>
              <p className="text-2xl font-semibold text-slate-900 mt-1">{summary?.pending_approvals ?? 0}건</p>
              <p className="text-xs text-slate-400 mt-2">관리자 확인이 필요한 업무</p>
            </div>
            <div className="rounded-[1.25rem] border border-slate-200 bg-white px-4 py-4">
              <p className="text-sm text-slate-500">오늘 일정</p>
              <p className="text-2xl font-semibold text-slate-900 mt-1">{summary?.today_schedules ?? 0}건</p>
              <p className="text-xs text-slate-400 mt-2">등록된 일정과 미팅</p>
            </div>
            <div className="rounded-[1.25rem] border border-slate-200 bg-white px-4 py-4">
              <p className="text-sm text-slate-500">출근 인원</p>
              <p className="text-2xl font-semibold text-slate-900 mt-1">{summary?.checked_in ?? 0}명</p>
              <p className="text-xs text-slate-400 mt-2">실시간 근태 집계</p>
            </div>
            <div className="rounded-[1.25rem] border border-slate-200 bg-white px-4 py-4">
              <p className="text-sm text-slate-500">오늘 매출</p>
              <p className="text-2xl font-semibold text-slate-900 mt-1">₩{(summary?.today_sales ?? 0).toLocaleString()}</p>
              <p className="text-xs text-slate-400 mt-2">당일 등록 기준</p>
            </div>
          </div>
        </div>
      </section>

      {canUsePromptWorkspace && (
        <section className="grid gap-4 xl:grid-cols-3">
          <div className="card bg-white">
            <p className="text-sm font-medium text-slate-500">출근까지 남은 시간</p>
            <p className="mt-2 text-2xl font-semibold text-slate-900">
              {alerts?.minutes_until_checkin > 0 ? `${alerts.minutes_until_checkin}분` : '도래'}
            </p>
            <p className="mt-2 text-xs text-slate-400">기준 출근 시각 09:00</p>
          </div>

          <div className="card bg-white">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-slate-500">아직 출근하지 않은 직원</p>
                <p className="mt-2 text-2xl font-semibold text-slate-900">{alerts?.unchecked_in_count ?? 0}명</p>
              </div>
              <button className="text-xs font-medium text-slate-600 hover:text-slate-900" onClick={() => router.push('/attendance')}>
                근태 열기
              </button>
            </div>
            {uncheckedPreview.length > 0 ? (
              <div className="mt-3 space-y-2">
                {uncheckedPreview.map((item) => (
                  <div key={item.id} className="rounded-2xl bg-slate-50 px-3 py-2">
                    <p className="text-sm font-medium text-slate-900">{item.name}</p>
                    <p className="text-xs text-slate-500">{item.department || '부서 미지정'} · {item.position || '직급 미지정'}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-emerald-600">오늘 기준 미출근 직원이 없습니다.</p>
            )}
          </div>

          <div className="card bg-white">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-slate-500">가까운 일정 / 승인</p>
                <p className="mt-2 text-2xl font-semibold text-slate-900">{alerts?.pending_approvals ?? 0}건</p>
              </div>
              <button className="text-xs font-medium text-slate-600 hover:text-slate-900" onClick={() => router.push('/approvals')}>
                승인 열기
              </button>
            </div>
            {upcomingSchedules.length > 0 ? (
              <div className="mt-3 space-y-2">
                {upcomingSchedules.map((item) => (
                  <div key={item.id} className="rounded-2xl bg-slate-50 px-3 py-2">
                    <p className="text-sm font-medium text-slate-900">{item.title}</p>
                    <p className="text-xs text-slate-500">
                      {new Date(item.start_time).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} · {item.type || 'task'}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-slate-500">가까운 일정이 없습니다.</p>
            )}
          </div>
        </section>
      )}

      {/* 요약 카드 */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <Card
          title="오늘 매출"
          value={`₩${(summary?.today_sales ?? 0).toLocaleString()}`}
          subtitle="매출 관리로 이동"
          icon="💰"
          color="blue"
          onClick={() => router.push('/sales')}
        />
        <Card
          title="출근 인원"
          value={`${summary?.checked_in ?? 0}명`}
          subtitle="근태 관리로 이동"
          icon="👥"
          color="green"
          onClick={() => router.push('/attendance')}
        />
        <Card
          title="미처리 문서"
          value={`${summary?.pending_docs ?? 0}건`}
          subtitle="업무 관리에서 처리"
          icon="📋"
          color="yellow"
          onClick={() => router.push('/journals')}
        />
        <Card
          title="대기 승인"
          value={`${summary?.pending_approvals ?? 0}건`}
          subtitle={isMember ? '운영 참고용' : '승인 관리로 이동'}
          icon="✅"
          color="red"
          onClick={() => router.push('/approvals')}
        />
        <Card
          title="진행 중 프로젝트"
          value={`${summary?.active_projects ?? 0}건`}
          subtitle="프로젝트 관리로 이동"
          icon="📋"
          color="blue"
          onClick={() => router.push('/projects')}
        />
        <Card
          title="오늘 일정"
          value={`${summary?.today_schedules ?? 0}건`}
          subtitle="일정 관리로 이동"
          icon="📅"
          color="green"
          onClick={() => router.push('/schedules')}
        />
      </div>

      <section className="grid gap-4 lg:grid-cols-4">
        {quickLinks.map((item) => (
          <button
            key={item.href}
            onClick={() => router.push(item.href)}
            className="card text-left hover:shadow-md transition-shadow bg-white"
          >
            <p className="text-sm font-semibold text-slate-900">{item.label}</p>
            <p className="text-sm text-slate-500 mt-2">{item.desc}</p>
          </button>
        ))}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 월간 매출 차트 */}
        <div className="card lg:col-span-2">
          <h2 className="font-semibold text-slate-800 mb-4">📈 월간 매출 (최근 30일)</h2>
          {monthlyData.length > 0 ? (
            <SalesBarChart data={monthlyData} />
          ) : (
            <div className="text-center py-10">
              <p className="text-4xl mb-3">📈</p>
              <p className="text-slate-500 text-sm">매출 데이터가 없습니다</p>
            </div>
          )}
        </div>

        {/* 최근 활동 — 월간·주간 옆에 row-span-2 */}
        <div className="card lg:row-span-2">
          <h2 className="font-semibold text-slate-800 mb-4">📋 최근 활동</h2>
          {activity.length === 0 ? (
            <p className="text-center text-slate-400 text-sm py-6">활동 내역 없음</p>
          ) : (
            <div className="relative">
              <div className="absolute left-3.5 top-0 bottom-0 w-px bg-slate-100" />
              <div className="space-y-4">
                {activity.map((item, i) => (
                  <div key={i} className="flex gap-3 items-start relative">
                    <div className="w-7 h-7 rounded-full bg-slate-100 flex items-center justify-center text-sm shrink-0 z-10">
                      {ACTIVITY_ICONS[item.type] || '🔔'}
                    </div>
                    <div className="flex-1 min-w-0 pt-0.5">
                      <p className="text-sm text-slate-700 leading-snug">{item.detail}</p>
                      <p className="text-xs text-slate-400 mt-0.5">{timeAgo(item.created_at)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 주간 매출 차트 */}
        <div className="card lg:col-span-2">
          <h2 className="font-semibold text-slate-800 mb-4">📊 주간 매출 (최근 7일)</h2>
          {salesData.length > 0 ? (
            <SalesBarChart data={salesData} />
          ) : (
            <div className="text-center py-10">
              <p className="text-4xl mb-3">📊</p>
              <p className="text-slate-500 text-sm mb-4">매출을 등록하면 차트가 표시됩니다</p>
              <Link href="/sales" className="inline-flex items-center gap-1 text-sm text-slate-900 font-medium hover:underline">
                매출 등록하기 →
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
