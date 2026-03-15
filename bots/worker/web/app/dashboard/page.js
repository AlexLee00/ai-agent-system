'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import Card from '@/components/Card';
import WorkerAIWorkspace from '@/components/WorkerAIWorkspace';
import { useAuth } from '@/lib/auth-context';

export default function DashboardPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [summary,      setSummary]      = useState(null);
  const [alerts,       setAlerts]       = useState(null);
  const [activities,   setActivities]   = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [workspaceDraft, setWorkspaceDraft] = useState('');
  const [workspaceDraftVersion, setWorkspaceDraftVersion] = useState(0);
  const canUsePromptWorkspace = ['admin', 'master'].includes(user?.role);
  const isMember = user?.role === 'member';

  useEffect(() => {
    const requests = [
      api.get('/dashboard/summary').catch(() => null),
      canUsePromptWorkspace ? api.get('/dashboard/alerts').catch(() => null) : Promise.resolve(null),
      api.get('/activity').catch(() => ({ activities: [] })),
    ];

    Promise.all(requests).then(([sum, alertData, activityData]) => {
      if (sum) setSummary(sum);
      if (alertData) setAlerts(alertData);
      setActivities(activityData?.activities || []);
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
  const pendingApprovals = summary?.pending_approvals ?? 0;
  const priorityItems = [
    canUsePromptWorkspace && pendingApprovals > 0
      ? { title: '승인 대기 확인', detail: `${pendingApprovals}건의 승인 요청이 쌓여 있습니다.`, href: '/approvals', tone: 'rose', prompt: '대기 승인 업무 보여줘' }
      : null,
    canUsePromptWorkspace && (alerts?.unchecked_in_count ?? 0) > 0
      ? { title: '미출근 직원 확인', detail: `${alerts.unchecked_in_count}명의 직원이 아직 출근하지 않았습니다.`, href: '/attendance', tone: 'amber', prompt: '오늘 미출근 직원 보여줘' }
      : null,
    (summary?.today_schedules ?? 0) > 0
      ? { title: '오늘 일정 점검', detail: `${summary.today_schedules}건의 일정이 등록되어 있습니다.`, href: '/schedules', tone: 'blue', prompt: '오늘 일정 요약해줘' }
      : null,
    (summary?.today_sales ?? 0) === 0
      ? { title: '매출 입력 확인', detail: '오늘 매출이 아직 등록되지 않았습니다.', href: '/sales', tone: 'emerald', prompt: '오늘 매출 상태 알려줘' }
      : null,
  ].filter(Boolean);

  const toneClasses = {
    rose: 'border-rose-200 bg-rose-50',
    amber: 'border-amber-200 bg-amber-50',
    blue: 'border-sky-200 bg-sky-50',
    emerald: 'border-emerald-200 bg-emerald-50',
  };

  const activityTypeLabel = {
    journal: '업무일지',
    attendance: '근태',
    sales: '매출',
    approval: '승인',
  };

  const activityActionMap = {
    attendance: { href: '/attendance', prompt: '최근 근태 처리 내역 요약해줘' },
    sales: { href: '/sales', prompt: '최근 매출 처리 내역 요약해줘' },
    journal: { href: '/journals', prompt: '최근 업무일지 처리 내역 요약해줘' },
    approval: { href: '/approvals', prompt: '최근 승인 처리 흐름 요약해줘' },
  };

  function handlePriorityAction(item) {
    if (!canUsePromptWorkspace || !item.prompt) {
      router.push(item.href);
      return;
    }
    setWorkspaceDraft(item.prompt);
    setWorkspaceDraftVersion((prev) => prev + 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function handleActivityAction(item) {
    const config = activityActionMap[item.type];
    if (!config) {
      router.push('/journals');
      return;
    }
    if (!canUsePromptWorkspace || !config.prompt) {
      router.push(config.href);
      return;
    }
    setWorkspaceDraft(config.prompt);
    setWorkspaceDraftVersion((prev) => prev + 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <div className="space-y-6">
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
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-500">운영 대화</p>
              <h2 className="mt-1 text-lg font-semibold text-slate-900">대시보드에서 바로 질의와 지시를 시작합니다</h2>
            </div>
            <button className="text-xs font-medium text-slate-600 hover:text-slate-900" onClick={() => router.push('/chat')}>
              전체 대화 화면 열기
            </button>
          </div>
          <WorkerAIWorkspace
            menuKey="dashboard"
            title="대시보드 운영 프롬프트"
            description="승인 대기, 미출근 직원, 오늘 일정, 운영 예외를 한 곳에서 질의하고 바로 처리 흐름으로 연결합니다."
            suggestions={[
              '오늘 미출근 직원 보여줘',
              '대기 승인 업무 보여줘',
              '오늘 일정 요약해줘',
              '오늘 매출 상태 알려줘',
            ]}
            allowUpload={false}
            agentName={user?.role === 'master' ? 'Worker 마스터 오케스트레이터' : 'Worker 운영 에이전트'}
            compact
            showCanvasPanel={false}
            showQueuePanel={false}
            showMasterSignalsPanel={false}
            externalDraft={workspaceDraft}
            draftVersion={workspaceDraftVersion}
          />
        </section>
      )}

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

      <section className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="card">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-slate-500">운영 캔버스</p>
              <h2 className="mt-1 text-lg font-semibold text-slate-900">지금 바로 확인할 항목</h2>
            </div>
            {!isMember && (
              <button className="text-xs font-medium text-slate-600 hover:text-slate-900" onClick={() => router.push('/chat')}>
                대화 시작
              </button>
            )}
          </div>
          <div className="mt-4 grid gap-3">
            {priorityItems.length === 0 ? (
              <div className="rounded-3xl border border-slate-200 bg-slate-50 px-5 py-6 text-sm text-slate-500">
                현재 즉시 조치가 필요한 항목이 없습니다.
              </div>
            ) : priorityItems.map((item) => (
              <div
                key={`${item.href}-${item.title}`}
                className={`rounded-3xl border px-5 py-4 text-left ${toneClasses[item.tone] || toneClasses.blue}`}
              >
                <p className="text-sm font-semibold text-slate-900">{item.title}</p>
                <p className="mt-2 text-sm text-slate-600">{item.detail}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    onClick={() => handlePriorityAction(item)}
                    className="rounded-full bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                  >
                    프롬프트에 채우기
                  </button>
                  <button
                    onClick={() => router.push(item.href)}
                    className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    메뉴 열기
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-slate-500">최근 업무 큐</p>
              <h2 className="mt-1 text-lg font-semibold text-slate-900">최신 처리 흐름</h2>
            </div>
            <button className="text-xs font-medium text-slate-600 hover:text-slate-900" onClick={() => router.push('/journals')}>
              업무 관리 열기
            </button>
          </div>
          <div className="mt-4 space-y-3">
            {activities.length === 0 ? (
              <div className="rounded-3xl border border-slate-200 bg-slate-50 px-5 py-6 text-sm text-slate-500">
                최근 활동이 없습니다.
              </div>
            ) : activities.slice(0, 6).map((item, index) => (
              <div key={`${item.type}-${item.created_at}-${index}`} className="rounded-3xl border border-slate-200 bg-slate-50 px-4 py-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-slate-900">{activityTypeLabel[item.type] || item.type}</p>
                  <span className="text-xs text-slate-400">
                    {item.created_at ? new Date(item.created_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '-'}
                  </span>
                </div>
                <p className="mt-2 text-sm text-slate-600">{item.detail}</p>
                {item.actor && <p className="mt-1 text-xs text-slate-400">담당: {item.actor}</p>}
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    onClick={() => handleActivityAction(item)}
                    className="rounded-full bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                  >
                    프롬프트에 채우기
                  </button>
                  <button
                    onClick={() => router.push(activityActionMap[item.type]?.href || '/journals')}
                    className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    메뉴 열기
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

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

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card">
          <h2 className="font-semibold text-slate-800 mb-4">📈 운영 메모</h2>
          <div className="space-y-3">
            <div className="rounded-2xl bg-slate-50 px-4 py-3">
              <p className="text-sm font-medium text-slate-900">오늘 매출</p>
              <p className="text-xs text-slate-500 mt-1">현재 등록 기준으로 집계됩니다.</p>
            </div>
            <div className="rounded-2xl bg-slate-50 px-4 py-3">
              <p className="text-sm font-medium text-slate-900">근태/일정 점검</p>
              <p className="text-xs text-slate-500 mt-1">근태와 일정 메뉴에서 바로 상세 확인이 가능합니다.</p>
            </div>
          </div>
        </div>

        <div className="card">
          <h2 className="font-semibold text-slate-800 mb-4">🧭 바로 가기</h2>
          <div className="space-y-2">
            {quickLinks.map((item) => (
              <button
                key={item.href}
                onClick={() => router.push(item.href)}
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left hover:bg-slate-50"
              >
                <p className="text-sm font-medium text-slate-900">{item.label}</p>
                <p className="text-xs text-slate-500 mt-1">{item.desc}</p>
              </button>
            ))}
          </div>
        </div>

        <div className="card">
          <h2 className="font-semibold text-slate-800 mb-4">📌 상태 요약</h2>
          <div className="space-y-3">
            <div className="rounded-2xl bg-slate-50 px-4 py-3">
              <p className="text-sm font-medium text-slate-900">대기 승인</p>
              <p className="text-xs text-slate-500 mt-1">{summary?.pending_approvals ?? 0}건</p>
            </div>
            <div className="rounded-2xl bg-slate-50 px-4 py-3">
              <p className="text-sm font-medium text-slate-900">오늘 일정</p>
              <p className="text-xs text-slate-500 mt-1">{summary?.today_schedules ?? 0}건</p>
            </div>
            <div className="rounded-2xl bg-slate-50 px-4 py-3">
              <p className="text-sm font-medium text-slate-900">진행 중 프로젝트</p>
              <p className="text-xs text-slate-500 mt-1">{summary?.active_projects ?? 0}건</p>
            </div>
            {canUsePromptWorkspace && (
              <div className="rounded-2xl bg-slate-50 px-4 py-3">
                <p className="text-sm font-medium text-slate-900">미출근 직원</p>
                <p className="text-xs text-slate-500 mt-1">{alerts?.unchecked_in_count ?? 0}명</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
