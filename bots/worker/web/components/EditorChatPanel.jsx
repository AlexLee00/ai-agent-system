'use client';

import { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Loader2,
  Send,
  SkipForward,
  Sparkles,
  Wand2,
} from 'lucide-react';

import ChatMessage from './ChatMessage';
import StepProgressBar from './StepProgressBar';

function formatTime(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds || 0)));
  const mm = String(Math.floor(safe / 60)).padStart(2, '0');
  const ss = String(safe % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function confidenceTone(value) {
  if (value >= 0.8) return 'bg-emerald-50 text-emerald-700';
  if (value >= 0.5) return 'bg-amber-50 text-amber-700';
  return 'bg-rose-50 text-rose-700';
}

function stepTypeLabel(type) {
  const labels = {
    cut: '삭제 구간',
    transition: '효과 삽입',
    video_insert: '추가 영상',
    audio_sync: '음성 배치',
    sync_match: '장면 싱크',
    intro: '인트로',
    outro: '아웃트로',
  };
  return labels[type] || type || '편집 스텝';
}

export default function EditorChatPanel({
  steps = [],
  currentStepIndex = 0,
  onStepClick,
  onConfirm,
  onModify,
  onSkip,
  onAdoptBlue,
  onFinalize,
  loading = false,
  phase = 'idle',
}) {
  const [prompt, setPrompt] = useState('');
  const currentStep = steps[currentStepIndex] || null;
  const pendingCount = steps.filter((step) => !step.user_action).length;
  const resolvedCount = steps.filter((step) => step.user_action).length;
  const canFinalize = steps.length > 0 && pendingCount === 0;

  const messages = useMemo(() => {
    const timestamp = new Date().toISOString();
    const list = [
      {
        id: 'intro',
        role: 'ai',
        content: steps.length
          ? `편집을 시작합니다. 총 ${steps.length}개 스텝을 생성했습니다. 자동 컨펌 ${steps.filter((step) => step.auto_confirm).length}개, 수동 검토 ${steps.filter((step) => !step.auto_confirm).length}개입니다.`
          : '편집 세션을 시작하면 RED/BLUE 제안이 이곳에 표시됩니다.',
        timestamp,
      },
    ];

    if (currentStep) {
      const narration = currentStep.proposal?.narration || {};
      const source = currentStep.proposal?.source || {};
      list.push({
        id: `step-${currentStep.step_index}`,
        role: 'ai',
        content: [
          `${stepTypeLabel(currentStep.step_type)} 스텝입니다.`,
          currentStep.proposal?.reason || '추천 편집 근거를 검토해주세요.',
          narration.topic ? `나레이션: ${narration.topic}` : null,
          source.description ? `장면: ${source.description}` : null,
          narration.start_s != null && narration.end_s != null
            ? `구간: ${formatTime(narration.start_s)} ~ ${formatTime(narration.end_s)}`
            : null,
        ].filter(Boolean).join('\n'),
        timestamp,
      });
    }

    if (currentStep?.red) {
      list.push({
        id: `red-${currentStep.step_index}`,
        role: 'red',
        content: `${currentStep.red.comment || 'RED 분석 코멘트가 없습니다.'}${Number.isFinite(Number(currentStep.red.score)) ? ` (score: ${currentStep.red.score})` : ''}`,
        timestamp,
      });
    }

    if (currentStep?.blue) {
      const alt = currentStep.blue.alternative_source || {};
      list.push({
        id: `blue-${currentStep.step_index}`,
        role: 'blue',
        content: [
          currentStep.blue.reason || 'BLUE 대안을 검토해주세요.',
          alt.description ? `대안 장면: ${alt.description}` : null,
          alt.start_s != null && alt.end_s != null
            ? `대안 구간: ${formatTime(alt.start_s)} ~ ${formatTime(alt.end_s)}`
            : null,
        ].filter(Boolean).join('\n'),
        timestamp,
      });
    }

    if (currentStep?.user_action) {
      list.push({
        id: `user-action-${currentStep.step_index}`,
        role: 'system',
        content: `현재 스텝은 "${currentStep.user_action}" 상태로 처리되었습니다.`,
        timestamp,
      });
    }

    if (canFinalize) {
      list.push({
        id: 'done',
        role: 'ai',
        content: '모든 스텝 처리가 완료되었습니다. 프리뷰 렌더링을 시작할 수 있습니다.',
        timestamp,
      });
    }

    return list;
  }, [canFinalize, currentStep, steps]);

  const actionDisabled = loading || !currentStep;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-200 px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-500">AI Edit Chat</p>
            <h2 className="mt-1 text-lg font-semibold text-slate-900">AI 편집 채팅</h2>
            <p className="mt-1 text-xs text-slate-500">RED/BLUE 제안과 사용자 판단을 채팅 형태로 기록합니다.</p>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">phase: {phase}</span>
        </div>
      </div>

      <div className="border-b border-slate-200 px-5 py-4">
        <StepProgressBar steps={steps} currentStepIndex={currentStepIndex} onStepClick={onStepClick} />
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-700">완료 {resolvedCount}</span>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-600">대기 {pendingCount}</span>
          {currentStep ? (
            <span className={`rounded-full px-2.5 py-1 font-semibold ${confidenceTone(Number(currentStep.confidence || 0))}`}>
              confidence {(Number(currentStep.confidence || 0) * 100).toFixed(0)}%
            </span>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
        {messages.map((message) => (
          <ChatMessage
            key={message.id}
            role={message.role}
            content={message.content}
            timestamp={message.timestamp}
          />
        ))}

        {currentStep ? (
          <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">현재 스텝</p>
                <h3 className="mt-1 text-sm font-semibold text-slate-900">{stepTypeLabel(currentStep.step_type)}</h3>
              </div>
              {currentStep.auto_confirm ? (
                <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">자동 컨펌 후보</span>
              ) : null}
            </div>
            <div className="mt-4 grid gap-2">
              <button
                type="button"
                disabled={actionDisabled}
                onClick={() => onConfirm?.(currentStep.step_index)}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white disabled:bg-slate-300"
              >
                <CheckCircle2 className="h-4 w-4" />
                컨펌
              </button>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={actionDisabled}
                  onClick={() => onSkip?.(currentStep.step_index)}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 disabled:bg-slate-100"
                >
                  <SkipForward className="h-4 w-4" />
                  건너뛰기
                </button>
                <button
                  type="button"
                  disabled={actionDisabled || !currentStep.blue}
                  onClick={() => onAdoptBlue?.(currentStep.step_index)}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm font-medium text-blue-700 disabled:opacity-50"
                >
                  <Sparkles className="h-4 w-4" />
                  BLUE 채택
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="border-t border-slate-200 px-5 py-4">
        <div className="rounded-3xl border border-slate-200 bg-white p-3 shadow-sm">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={3}
            placeholder="예: 00:45부터 삭제로 바꿔줘, 이 구간은 장면 전환을 더 부드럽게 해줘"
            className="w-full resize-none border-none bg-transparent px-1 py-1 text-sm text-slate-800 outline-none placeholder:text-slate-400"
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs text-slate-400">현재 스텝에 대한 수정 메모를 직접 남길 수 있습니다.</p>
            <div className="flex items-center gap-2">
              {canFinalize ? (
                <button
                  type="button"
                  disabled={loading}
                  onClick={onFinalize}
                  className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-300"
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                  프리뷰 렌더링
                </button>
              ) : null}
              <button
                type="button"
                disabled={!currentStep || !prompt.trim() || loading}
                onClick={() => {
                  onModify?.(currentStep.step_index, {
                    reason: prompt.trim(),
                    operator_note: prompt.trim(),
                  });
                  setPrompt('');
                }}
                className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-300"
              >
                <Send className="h-4 w-4" />
                수정 전송
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
