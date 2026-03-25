'use client';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { getToken } from '@/lib/auth-context';
import AdminQuickNav from '@/components/AdminQuickNav';
import AdminPageHero from '@/components/AdminPageHero';
import { useAuth } from '@/lib/auth-context';
import PromptAdvisor from '@/components/PromptAdvisor';
import OperationsSectionHeader from '@/components/OperationsSectionHeader';
import OperationsSplitLayout from '@/components/OperationsSplitLayout';
import { parseClaudeOutput } from '../ai/canvas';
import { buildDocumentPromptAppendix, buildDocumentUploadNotice, mergePromptWithDocumentContext } from '@/lib/document-attachment';
import { consumeDocumentReuseDraft } from '@/lib/document-reuse-draft';
import useAutoResizeTextarea from '@/lib/useAutoResizeTextarea';

export default function DashboardPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [summary,      setSummary]      = useState(null);
  const [alerts,       setAlerts]       = useState(null);
  const [activities,   setActivities]   = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [loadError, setLoadError] = useState('');
  const [prompt,       setPrompt]       = useState('');
  const [advisorResult, setAdvisorResult] = useState(null);
  const [attachedFileName, setAttachedFileName] = useState('');
  const [attachedDocumentContext, setAttachedDocumentContext] = useState('');
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [reusedDocument, setReusedDocument] = useState(null);
  const fileRef = useRef(null);
  const promptRef = useRef(null);
  const advisorSectionRef = useRef(null);
  const canUsePromptWorkspace = ['admin', 'master'].includes(user?.role);
  const isMember = user?.role === 'member';

  useEffect(() => {
    if (authLoading) return;
    if (!getToken() || !user) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setLoadError('');

    const requests = [
      api.get('/dashboard/summary'),
      canUsePromptWorkspace ? api.get('/dashboard/alerts') : Promise.resolve(null),
      api.get('/activity'),
    ];

    Promise.allSettled(requests)
      .then(([sum, alertData, activityData]) => {
        if (sum.status === 'fulfilled') setSummary(sum.value);
        else setSummary(null);

        if (alertData.status === 'fulfilled') setAlerts(alertData.value);
        else setAlerts(null);

        if (activityData.status === 'fulfilled') setActivities(activityData.value?.activities || []);
        else setActivities([]);

        const firstFailure = [sum, alertData, activityData].find((result) => result.status === 'rejected');
        if (firstFailure) {
          setLoadError(firstFailure.reason?.message || '대시보드 데이터를 불러오지 못했습니다.');
        }
      })
      .finally(() => setLoading(false));
  }, [authLoading, canUsePromptWorkspace, user?.id]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const nextPrompt = new URLSearchParams(window.location.search).get('prompt') || '';
    const reusedDraft = consumeDocumentReuseDraft('dashboard');
    if (reusedDraft?.documentId || reusedDraft?.filename) setReusedDocument(reusedDraft);
    const reusedText = reusedDraft?.draft || '';
    const merged = [nextPrompt, reusedText].filter(Boolean).join(nextPrompt && reusedText ? '\n\n' : '');
    setPrompt((prev) => (prev === merged ? prev : merged));
  }, []);

  useAutoResizeTextarea(promptRef, prompt);

  if (loading) return <div className="text-center py-20 text-gray-400">로딩 중...</div>;

  const uncheckedPreview = alerts?.unchecked_in_preview || [];
  const upcomingSchedules = alerts?.upcoming_schedules || [];
  const dueProjects = alerts?.due_projects_preview || [];
  const pendingApprovals = summary?.pending_approvals ?? 0;
  const priorityItems = [
    canUsePromptWorkspace && pendingApprovals > 0
      ? { title: '승인 대기 확인', detail: `${pendingApprovals}건의 승인 요청이 쌓여 있습니다.`, href: '/approvals', tone: 'rose', prompt: '대기 승인 업무 보여줘', bot: 'worker', severity: 'high', badge: '즉시 확인' }
      : null,
    canUsePromptWorkspace && (alerts?.unchecked_in_count ?? 0) > 0
      ? { title: '미출근 직원 확인', detail: `${alerts.unchecked_in_count}명의 직원이 아직 출근하지 않았습니다.`, href: '/attendance', tone: 'amber', prompt: '오늘 미출근 직원 보여줘', bot: 'noah', severity: 'high', badge: '주의 필요' }
      : null,
    (summary?.today_schedules ?? 0) > 0
      ? { title: '오늘 일정 점검', detail: `${summary.today_schedules}건의 일정이 등록되어 있습니다.`, href: '/schedules', tone: 'blue', prompt: '오늘 일정 요약해줘', bot: 'chloe', severity: 'medium', badge: '운영 확인' }
      : null,
    (summary?.today_sales ?? 0) === 0
      ? { title: '매출 입력 확인', detail: '오늘 매출이 아직 등록되지 않았습니다.', href: '/sales', tone: 'emerald', prompt: '오늘 매출 상태 알려줘', bot: 'oliver', severity: 'medium', badge: '등록 필요' }
      : null,
    (alerts?.pending_docs_count ?? 0) > 0
      ? { title: '문서 적체 확인', detail: `AI 요약이 없는 문서 ${alerts.pending_docs_count}건이 남아 있습니다.`, href: '/work-journals', tone: 'blue', prompt: '문서 적체와 업무 상태 점검해줘', bot: 'worker', severity: 'medium', badge: '우선 정리' }
      : null,
    (alerts?.due_projects_count ?? 0) > 0
      ? { title: '프로젝트 마감 확인', detail: `${alerts.due_projects_count}건의 프로젝트가 7일 내 마감 예정입니다.`, href: '/projects', tone: 'amber', prompt: '마감 임박 프로젝트 점검해줘', bot: 'ryan', severity: 'medium', badge: '일정 주의' }
      : null,
  ]
    .filter(Boolean)
    .sort((a, b) => {
      const severityOrder = { high: 0, medium: 1, low: 2 };
      return (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9);
    });

  const toneClasses = {
    rose: 'border-rose-200 bg-rose-50/90 shadow-[0_8px_24px_-18px_rgba(225,29,72,0.45)]',
    amber: 'border-amber-200 bg-amber-50/90 shadow-[0_8px_24px_-18px_rgba(217,119,6,0.4)]',
    blue: 'border-sky-200 bg-sky-50/90 shadow-[0_8px_24px_-18px_rgba(2,132,199,0.35)]',
    emerald: 'border-emerald-200 bg-emerald-50/90 shadow-[0_8px_24px_-18px_rgba(5,150,105,0.35)]',
  };
  const badgeClasses = {
    rose: 'bg-rose-100 text-rose-700',
    amber: 'bg-amber-100 text-amber-700',
    blue: 'bg-sky-100 text-sky-700',
    emerald: 'bg-emerald-100 text-emerald-700',
  };

  const activityTypeLabel = {
    journal: '업무일지',
    attendance: '근태',
    schedule: '일정',
    sales: '매출',
    document: '문서',
    project: '프로젝트',
    approval: '승인',
  };
  const activityTypeTone = {
    journal: 'slate',
    attendance: 'amber',
    schedule: 'blue',
    sales: 'emerald',
    document: 'blue',
    project: 'blue',
    approval: 'rose',
  };
  const activityTypeBadge = {
    journal: '기록',
    attendance: '근태',
    schedule: '일정',
    sales: '매출',
    document: '문서',
    project: '프로젝트',
    approval: '승인',
  };
  const activityPriorityBadge = {
    approval: { label: '즉시 확인', className: 'bg-rose-100 text-rose-700' },
    attendance: { label: '주의 필요', className: 'bg-amber-100 text-amber-700' },
    schedule: { label: '일정 확인', className: 'bg-sky-100 text-sky-700' },
    sales: { label: '등록 확인', className: 'bg-emerald-100 text-emerald-700' },
    document: { label: '적체 확인', className: 'bg-sky-100 text-sky-700' },
    project: { label: '마감 확인', className: 'bg-sky-100 text-sky-700' },
    journal: { label: '운영 기록', className: 'bg-slate-200 text-slate-700' },
  };
  const activityToneClasses = {
    rose: 'border-rose-200 bg-rose-50/80',
    amber: 'border-amber-200 bg-amber-50/80',
    emerald: 'border-emerald-200 bg-emerald-50/80',
    slate: 'border-slate-200 bg-slate-50',
  };
  const activityBadgeClasses = {
    rose: 'bg-rose-100 text-rose-700',
    amber: 'bg-amber-100 text-amber-700',
    emerald: 'bg-emerald-100 text-emerald-700',
    slate: 'bg-slate-200 text-slate-700',
  };

  const miniActionClass =
    'inline-flex shrink-0 whitespace-nowrap items-center rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-100';
  const overviewCards = [
    {
      label: '근태 상태',
      value: `${alerts?.unchecked_in_count ?? 0}명`,
      caption: `출근까지 ${alerts?.minutes_until_checkin > 0 ? `${alerts.minutes_until_checkin}분` : '도래'} · 기준 09:00`,
      body: uncheckedPreview.length > 0
        ? `미출근: ${uncheckedPreview.slice(0, 2).map((item) => item.name).join(', ')}`
        : '오늘 기준 미출근 직원이 없습니다.',
      actionLabel: '근태 열기',
      actionHref: '/attendance',
    },
    {
      label: '오늘 일정',
      value: `${summary?.today_schedules ?? 0}건`,
      caption: '등록된 일정과 미팅',
      body: '오늘 일정과 미팅 흐름을 점검합니다.',
      actionLabel: '일정 열기',
      actionHref: '/schedules',
    },
    {
      label: '업무 상태',
      value: `${alerts?.pending_docs_count ?? 0}건`,
      caption: 'AI 요약이 아직 없는 문서 기준',
      body: '업무 관리에서 먼저 정리할 항목입니다.',
      actionLabel: '업무 열기',
      actionHref: '/work-journals',
    },
    {
      label: '오늘 매출',
      value: `₩${(summary?.today_sales ?? 0).toLocaleString()}`,
      caption: '당일 등록 기준',
      body: '현재 등록된 매출 기준으로 집계합니다.',
      actionLabel: '매출 열기',
      actionHref: '/sales',
    },
    {
      label: '프로젝트 마감 임박',
      value: `${alerts?.due_projects_count ?? 0}건`,
      caption: '7일 이내 마감 예정 프로젝트 기준입니다.',
      body: '7일 내 마감 프로젝트가 없습니다.',
      actionLabel: '프로젝트 열기',
      actionHref: '/projects',
    },
    {
      label: '대기 승인',
      value: `${summary?.pending_approvals ?? 0}건`,
      caption: '관리자 확인이 필요한 업무',
      body: '승인 요청 흐름을 먼저 확인하세요.',
      actionLabel: '승인 열기',
      actionHref: '/approvals',
    },
  ];

  function renderOverviewCard(item, key = item.label) {
    return (
      <div key={key} className="rounded-3xl border border-slate-200 bg-white px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-slate-500">{item.label}</p>
            <p className="mt-2 text-xl font-semibold text-slate-900 sm:text-2xl">{item.value}</p>
          </div>
          <button className={miniActionClass} onClick={() => router.push(item.actionHref)}>
            {item.actionLabel}
          </button>
        </div>
        <div className="mt-3 space-y-3">
          <p className="text-xs leading-relaxed text-slate-400 break-keep">{item.caption}</p>
          <p className="text-sm leading-relaxed text-slate-500 break-keep">{item.body}</p>
        </div>
      </div>
    );
  }

  function handlePriorityAction(item) {
    if (!canUsePromptWorkspace || !item.prompt) return router.push(item.href);
    setPrompt(item.prompt);
    setAdvisorResult(buildDashboardAdvisorResult(item.prompt));
    advisorSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function buildDashboardAdvisorResult(input) {
    const normalized = input.toLowerCase();
    const result = {
      title: '운영 요약 추천',
      summary: '현재 대시보드 기준으로 바로 확인할 항목을 묶어서 안내합니다.',
      markdown: '',
      uiComponent: null,
      actionLabel: 'AI 분석 열기',
      actionHref: '/ai',
    };

    if (normalized.includes('미출근') || normalized.includes('출근') || normalized.includes('근태')) {
      result.title = '근태 상태 추천';
      result.summary = `${alerts?.unchecked_in_count ?? 0}명의 미출근 직원을 먼저 확인하는 흐름이 적합합니다.`;
      result.markdown = [
        '## 근태 상태 추천',
        '',
        `- 출근 기준 시각은 **09:00**이고 현재 상태는 **${alerts?.minutes_until_checkin > 0 ? `${alerts.minutes_until_checkin}분 전` : '도래'}**입니다.`,
        uncheckedPreview.length > 0
          ? `- 미출근 직원: **${uncheckedPreview.slice(0, 3).map((item) => item.name).join(', ')}**`
          : '- 현재 미출근 직원은 없습니다.',
        '- 근태 메뉴에서 출근/휴가/수정 흐름을 이어서 확인하면 좋습니다.',
      ].join('\n');
      result.actionLabel = '근태 열기';
      result.actionHref = '/attendance';
      result.uiComponent = parseClaudeOutput(result.markdown);
      return result;
    }

    if (normalized.includes('승인')) {
      result.title = '승인 흐름 추천';
      result.summary = `현재 대기 승인 ${summary?.pending_approvals ?? 0}건 기준으로 우선순위를 확인하는 것이 좋습니다.`;
      result.markdown = [
        '## 승인 흐름 추천',
        '',
        summary?.pending_approvals
          ? `- 승인 요청 **${summary.pending_approvals}건**이 대기 중입니다.`
          : '- 현재 대기 승인 요청은 없습니다.',
        '- 승인 메뉴에서 상태 탭 기준으로 대기/완료/반려를 같이 점검할 수 있습니다.',
        '- 필요하면 관련 메뉴로 이동해 세부 내용을 다시 확인하세요.',
      ].join('\n');
      result.actionLabel = '승인 열기';
      result.actionHref = '/approvals';
      result.uiComponent = parseClaudeOutput(result.markdown);
      return result;
    }

    if (normalized.includes('일정')) {
      result.title = '일정 점검 추천';
      result.summary = `오늘 일정 ${summary?.today_schedules ?? 0}건 기준으로 일정 흐름을 확인하는 것이 적합합니다.`;
      result.markdown = [
        '## 일정 점검 추천',
        '',
        summary?.today_schedules
          ? `- 등록된 일정은 **${summary.today_schedules}건**입니다.`
          : '- 오늘 등록된 일정은 없습니다.',
        upcomingSchedules.length > 0
          ? `- 가까운 일정: **${upcomingSchedules.slice(0, 2).map((item) => item.title).join(', ')}**`
          : '- 가까운 일정 미리보기는 아직 비어 있습니다.',
        '- 일정 메뉴에서 일정 생성/수정/확정 흐름을 이어서 볼 수 있습니다.',
      ].join('\n');
      result.actionLabel = '일정 열기';
      result.actionHref = '/schedules';
      result.uiComponent = parseClaudeOutput(result.markdown);
      return result;
    }

    if (normalized.includes('매출')) {
      result.title = '매출 상태 추천';
      result.summary = `오늘 매출은 ₩${(summary?.today_sales ?? 0).toLocaleString()} 기준으로 집계됩니다.`;
      result.markdown = [
        '## 매출 상태 추천',
        '',
        (summary?.today_sales ?? 0) > 0
          ? '- 오늘 등록된 매출이 있습니다.'
          : '- 오늘 매출이 아직 등록되지 않았습니다.',
        '- 매출 메뉴에서 입력 누락 여부와 최근 처리 내역을 함께 확인하세요.',
        '- 필요하면 자연어 입력으로 새 매출 제안을 바로 만들 수 있습니다.',
      ].join('\n');
      result.actionLabel = '매출 열기';
      result.actionHref = '/sales';
      result.uiComponent = parseClaudeOutput(result.markdown);
      return result;
    }

    if (normalized.includes('프로젝트') || normalized.includes('마감')) {
      result.title = '프로젝트 마감 추천';
      result.summary = `${alerts?.due_projects_count ?? 0}건의 마감 임박 프로젝트를 기준으로 점검을 추천합니다.`;
      result.markdown = [
        '## 프로젝트 마감 추천',
        '',
        dueProjects.length > 0
          ? `- 우선 확인 프로젝트: **${dueProjects.slice(0, 2).map((item) => item.name || item.title).join(', ')}**`
          : '- 7일 내 마감 임박 프로젝트는 없습니다.',
        '- 프로젝트 메뉴에서 지연/마감 흐름을 먼저 확인하면 좋습니다.',
        '- 필요하면 프로젝트별 회고나 일정 조정도 바로 이어서 볼 수 있습니다.',
      ].join('\n');
      result.actionLabel = '프로젝트 열기';
      result.actionHref = '/projects';
      result.uiComponent = parseClaudeOutput(result.markdown);
      return result;
    }

    if (normalized.includes('문서') || normalized.includes('업무')) {
      result.title = '업무 적체 추천';
      result.summary = `${alerts?.pending_docs_count ?? 0}건의 문서 적체를 먼저 점검하는 흐름이 적합합니다.`;
      result.markdown = [
        '## 업무 적체 추천',
        '',
        (alerts?.pending_docs_count ?? 0) > 0
          ? `- AI 요약이 없는 문서 **${alerts.pending_docs_count}건**이 남아 있습니다.`
          : '- 현재 문서 적체는 없습니다.',
        '- 업무 관리 메뉴에서 우선 정리할 문서/기록을 확인하세요.',
        '- 업무일지와 문서 흐름을 같이 보면 누락된 처리도 찾기 쉽습니다.',
      ].join('\n');
      result.actionLabel = '업무 열기';
      result.actionHref = '/work-journals';
      result.uiComponent = parseClaudeOutput(result.markdown);
      return result;
    }

    result.markdown = [
      '## 운영 요약 추천',
      '',
      `- 대기 승인 **${summary?.pending_approvals ?? 0}건**, 오늘 일정 **${summary?.today_schedules ?? 0}건**, 오늘 매출 **₩${(summary?.today_sales ?? 0).toLocaleString()}** 상태입니다.`,
      `- 미출근 직원 **${alerts?.unchecked_in_count ?? 0}명**, 문서 적체 **${alerts?.pending_docs_count ?? 0}건**을 함께 확인할 수 있습니다.`,
      '- 대시보드에서 방향을 잡고, 필요한 메뉴로 이동해 세부 점검을 이어가면 좋습니다.',
    ].join('\n');
    result.actionLabel = 'AI 분석 열기';
    result.actionHref = '/ai';
    result.uiComponent = parseClaudeOutput(result.markdown);
    return result;
  }

  function handleDashboardPromptSubmit() {
    const nextPrompt = prompt.trim();
    if (!(nextPrompt || attachedDocumentContext.trim())) return;
    setError('');
    setAdvisorResult(buildDashboardAdvisorResult(mergePromptWithDocumentContext(nextPrompt, attachedDocumentContext)));
    setPrompt('');
    setAttachedFileName('');
    setAttachedDocumentContext('');
  }

  async function handleUpload(input) {
    const file = input instanceof File ? input : input?.target?.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    setUploading(true);
    setError('');
    setNotice('');
    try {
      const token = getToken();
      const res = await fetch('/api/documents/upload', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '파일 업로드 실패');
      const filename = data.document?.filename || file.name;
      const appendix = buildDocumentPromptAppendix(data.document, file.name);
      setAttachedFileName(filename);
      setAttachedDocumentContext(appendix);
      setAdvisorResult(null);
      setNotice(buildDocumentUploadNotice(data.document, file.name));
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {canUsePromptWorkspace && <AdminQuickNav title="관리 화면 바로가기" />}

      {loadError ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {loadError}
        </div>
      ) : null}

      <AdminPageHero
        title="워커 운영 대시보드"
        description={
          isMember
            ? '내 업무와 운영 내역을 읽기 전용으로 빠르게 확인할 수 있습니다.'
            : '프롬프트 입력과 운영 요약, 매출과 일정 상태를 한 번에 확인할 수 있습니다.'
        }
      >
        {canUsePromptWorkspace && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {overviewCards.map((item) => renderOverviewCard(item))}
          </div>
        )}
      </AdminPageHero>

      {canUsePromptWorkspace && (
        <>
          <input ref={fileRef} type="file" className="hidden" onChange={handleUpload} />
          <div ref={advisorSectionRef}>
            <PromptAdvisor
              title="프롬프트 어드바이저"
              description="운영 질문을 먼저 정리하고, 대시보드 안에서 바로 추천 결과를 확인합니다."
              badge={user?.role === 'master' ? 'Worker 마스터 오케스트레이터' : 'Worker 운영 에이전트'}
              suggestions={[
                '오늘 미출근 직원 보여줘',
                '대기 승인과 오늘 일정 같이 요약해줘',
                '오늘 매출 상태 알려줘',
                '문서 적체와 프로젝트 마감 점검해줘',
              ]}
              helperText="운영 요약, 승인 대기, 미출근, 일정, 매출, 프로젝트, 문서 적체처럼 대시보드에서 바로 판단할 질문에 적합합니다."
              prompt={prompt}
              onPromptChange={(value) => {
                setPrompt(value);
                setAdvisorResult(null);
              }}
              promptRef={promptRef}
              placeholder="메시지 입력"
              onFileClick={() => fileRef.current?.click()}
              onFileDrop={handleUpload}
              uploading={uploading}
              attachedFileName={attachedFileName}
              onReset={() => {
                setPrompt('');
                setAdvisorResult(null);
                setAttachedFileName('');
                setAttachedDocumentContext('');
                setNotice('');
                setError('');
              }}
              onSubmit={handleDashboardPromptSubmit}
              submitDisabled={!(prompt.trim() || attachedDocumentContext.trim())}
              error={error}
              notice={notice}
              result={advisorResult}
              onResultAction={() => router.push(advisorResult.actionHref)}
            />
            {reusedDocument ? (
              <div className="mt-3 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
                <p className="font-semibold">문서 재사용 초안이 적용됨</p>
                <p className="mt-1 text-sky-800">{reusedDocument.filename || '이전 문서'}에서 가져온 내용을 기반으로 프롬프트가 채워졌습니다.</p>
                {reusedDocument.documentId ? (
                  <a href={`/documents/${reusedDocument.documentId}`} className="mt-2 inline-flex text-xs font-medium text-sky-700 hover:text-sky-900">
                    문서 상세 보기
                  </a>
                ) : null}
              </div>
            ) : null}
          </div>
        </>
      )}

      <OperationsSplitLayout
        left={(
        <div className="card">
          <OperationsSectionHeader
            eyebrow="운영 캔버스"
            title="지금 바로 확인할 항목"
            description="우선순위가 높은 항목부터 위쪽에 정렬됩니다."
          />
          <div className="mt-4 grid gap-3">
            {priorityItems.length === 0 ? (
              <div className="rounded-3xl border border-slate-200 bg-slate-50 px-5 py-6 text-sm text-slate-500">
                현재 즉시 조치가 필요한 항목이 없습니다.
              </div>
            ) : priorityItems.map((item) => (
              <button
                type="button"
                key={`${item.href}-${item.title}`}
                onClick={() => handlePriorityAction(item)}
                className={`w-full rounded-3xl border px-5 py-4 text-left transition hover:-translate-y-0.5 ${toneClasses[item.tone] || toneClasses.blue}`}
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <p className="text-sm font-semibold text-slate-900">{item.title}</p>
                  {item.badge ? (
                    <span className={`self-start rounded-full px-2.5 py-1 text-[11px] font-semibold ${badgeClasses[item.tone] || badgeClasses.blue}`}>
                      {item.badge}
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 text-sm leading-relaxed text-slate-600 break-keep">{item.detail}</p>
              </button>
            ))}
          </div>
        </div>
        )}
        right={(
        <div className="card">
          <OperationsSectionHeader
            eyebrow="최근 업무 큐"
            title="최신 처리 흐름"
            description="처리 유형별 배지와 최신 시각을 기준으로 흐름을 빠르게 읽을 수 있습니다."
          />
          <div className="mt-4 space-y-3 lg:max-h-[44rem] lg:overflow-y-auto lg:pr-1">
            {activities.length === 0 ? (
              <div className="rounded-3xl border border-slate-200 bg-slate-50 px-5 py-6 text-sm text-slate-500">
                최근 활동이 없습니다.
              </div>
            ) : activities.slice(0, 10).map((item, index) => (
              <div
                key={`${item.type}-${item.created_at}-${index}`}
                className={`rounded-3xl border px-4 py-4 ${activityToneClasses[activityTypeTone[item.type] || 'slate']}`}
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-slate-900">{activityTypeLabel[item.type] || item.type}</p>
                    <span
                      className={`self-start rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                        activityBadgeClasses[activityTypeTone[item.type] || 'slate']
                      }`}
                    >
                      {activityTypeBadge[item.type] || '활동'}
                    </span>
                    {activityPriorityBadge[item.type] ? (
                      <span
                        className={`self-start rounded-full px-2.5 py-1 text-[11px] font-semibold ${activityPriorityBadge[item.type].className}`}
                      >
                        {activityPriorityBadge[item.type].label}
                      </span>
                    ) : null}
                  </div>
                  <span className="text-xs leading-relaxed text-slate-400 break-keep">
                    {item.created_at ? new Date(item.created_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '-'}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-slate-600 break-keep">{item.detail}</p>
                {item.actor && <p className="mt-1 text-xs text-slate-400">담당: {item.actor}</p>}
              </div>
            ))}
          </div>
        </div>
        )}
      />
    </div>
  );
}
