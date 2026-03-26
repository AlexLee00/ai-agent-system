'use client';

import { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Loader2,
  Scissors,
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

function formatMs(ms) {
  return formatTime(Number(ms || 0) / 1000);
}

function confidenceTone(value) {
  if (value >= 0.8) return 'bg-emerald-500/15 text-emerald-300';
  if (value >= 0.5) return 'bg-amber-500/15 text-amber-300';
  return 'bg-rose-500/15 text-rose-300';
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

function summarizeCutCounts(items = []) {
  return items.reduce((acc, item) => {
    if (item.user_action === 'confirm') acc.confirmed += 1;
    else if (item.user_action === 'modify') acc.modified += 1;
    else if (item.user_action === 'skip') acc.skipped += 1;
    else acc.pending += 1;
    return acc;
  }, { confirmed: 0, modified: 0, skipped: 0, pending: 0 });
}

export default function EditorChatPanel({
  mode = 'steps',
  steps = [],
  cutItems = [],
  effectItems = [],
  currentCutDraft = null,
  currentStepIndex = 0,
  currentCutIndex = 0,
  currentEffectIndex = 0,
  onStepClick,
  onCutItemClick,
  onCutConfirm,
  onCutModify,
  onCutSkip,
  onCutFinalize,
  onEffectItemClick,
  onEffectConfirm,
  onEffectModify,
  onEffectSkip,
  onEffectFinalize,
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
  const currentCutItem = cutItems[currentCutIndex] || null;
  const currentEffectItem = effectItems[currentEffectIndex] || null;
  const pendingCount = steps.filter((step) => !step.user_action).length;
  const resolvedCount = steps.filter((step) => step.user_action).length;
  const canFinalize = steps.length > 0 && pendingCount === 0;
  const cutCounts = useMemo(() => summarizeCutCounts(cutItems), [cutItems]);
  const canFinalizeCut = cutItems.length === 0 || cutCounts.pending === 0;
  const effectCounts = useMemo(() => summarizeCutCounts(effectItems), [effectItems]);
  const canFinalizeEffect = effectItems.length === 0 || effectCounts.pending === 0;

  const messages = useMemo(() => {
    const timestamp = new Date().toISOString();

    if (mode === 'cut') {
      const list = [
        {
          id: 'cut-intro',
          role: 'ai',
          content: 'AI가 불필요 구간을 확인 중입니다.',
          timestamp,
        },
        {
          id: 'cut-summary',
          role: 'ai',
          content: cutItems.length
            ? `불필요 구간 편집을 제안합니다. 총 ${cutItems.length}개의 삭제 후보를 찾았습니다.`
            : '불필요 구간 후보를 찾지 못했습니다. 그대로 다음 단계로 진행할 수 있어요.',
          timestamp,
        },
      ];

      if (currentCutItem) {
        list.push({
          id: `cut-item-${currentCutItem.item_index}`,
          role: 'ai',
          content: [
            `컷 제안 ${currentCutItem.item_index + 1}번입니다.`,
            `구간: ${formatMs(currentCutItem.proposal_start_ms)} ~ ${formatMs(currentCutItem.proposal_end_ms)}`,
            currentCutItem.reason_text || '현재 장면 후반부를 줄이는 제안입니다.',
            currentCutItem.scene?.description ? `장면: ${currentCutItem.scene.description}` : null,
          ].filter(Boolean).join('\n'),
          timestamp,
        });
      }

      return list;
    }

    if (mode === 'effect') {
      const list = [
        {
          id: 'effect-intro',
          role: 'ai',
          content: 'AI가 강조하면 좋은 구간과 효과 타입을 정리하고 있습니다.',
          timestamp,
        },
        {
          id: 'effect-summary',
          role: 'ai',
          content: effectItems.length
            ? `효과 삽입을 제안합니다. 총 ${effectItems.length}개의 효과 후보를 검토해주세요.`
            : '효과를 꼭 넣어야 할 구간은 찾지 못했습니다. 그대로 다음 단계로 진행할 수 있어요.',
          timestamp,
        },
      ];

      if (currentEffectItem) {
        const narration = currentEffectItem.proposal?.narration || {};
        const effect = currentEffectItem.effect || {};
        list.push({
          id: `effect-item-${currentEffectItem.step_index}`,
          role: 'ai',
          content: [
            `${effect.effect_label || '효과 삽입'} 후보입니다.`,
            narration.start_s != null && narration.end_s != null
              ? `구간: ${formatTime(narration.start_s)} ~ ${formatTime(narration.end_s)}`
              : null,
            currentEffectItem.proposal?.reason || '강조 효과로 전달력을 높일 수 있습니다.',
            effect.target_hint ? `포인트: ${effect.target_hint}` : null,
          ].filter(Boolean).join('\n'),
          timestamp,
        });
      }

      return list;
    }

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
  }, [canFinalize, currentCutItem, currentEffectItem, currentStep, cutItems, effectItems.length, mode, steps]);

  const actionDisabled = loading || !currentStep;
  const cutActionDisabled = loading || !currentCutItem;
  const effectActionDisabled = loading || !currentEffectItem;

  return (
    <div className="flex h-full flex-col bg-[#17181b] text-slate-100">
      <div className="border-b border-slate-800 bg-[#1d1e22] px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300">AI Edit Chat</p>
            <h2 className="mt-1 text-lg font-semibold text-white">AI 편집 채팅</h2>
            <p className="mt-1 text-xs text-slate-400">
              {mode === 'cut'
                ? '1단계 컷 편집 제안과 사용자 확정 이력을 채팅 형태로 기록합니다.'
                : mode === 'effect'
                  ? '2단계 효과 삽입 제안과 사용자 판단 이력을 채팅 형태로 기록합니다.'
                  : 'RED/BLUE 제안과 사용자 판단을 채팅 형태로 기록합니다.'}
            </p>
          </div>
          <span className="rounded-full bg-slate-800 px-3 py-1 text-xs font-semibold text-slate-300">phase: {phase}</span>
        </div>
      </div>

      <div className="border-b border-slate-800 bg-[#191a1d] px-5 py-4">
        {mode === 'cut' ? (
          <>
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              {cutItems.map((item, index) => (
                <button
                  key={item.item_index}
                  type="button"
                  onClick={() => onCutItemClick?.(index)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold whitespace-nowrap ${
                    index === currentCutIndex
                      ? 'bg-cyan-400 text-slate-950'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  컷 {index + 1}
                </button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 font-semibold text-emerald-300">확정 {cutCounts.confirmed + cutCounts.modified}</span>
              <span className="rounded-full bg-slate-800 px-2.5 py-1 font-semibold text-slate-300">대기 {cutCounts.pending}</span>
              <span className={`rounded-full px-2.5 py-1 font-semibold ${confidenceTone(Number(currentCutItem?.confidence || 0))}`}>
                confidence {(Number(currentCutItem?.confidence || 0) * 100).toFixed(0)}%
              </span>
            </div>
          </>
        ) : mode === 'effect' ? (
          <>
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              {effectItems.map((item, index) => (
                <button
                  key={item.step_index}
                  type="button"
                  onClick={() => onEffectItemClick?.(index)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold whitespace-nowrap ${
                    index === currentEffectIndex
                      ? 'bg-cyan-400 text-slate-950'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  효과 {index + 1}
                </button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 font-semibold text-emerald-300">확정 {effectCounts.confirmed + effectCounts.modified}</span>
              <span className="rounded-full bg-slate-800 px-2.5 py-1 font-semibold text-slate-300">대기 {effectCounts.pending}</span>
              <span className={`rounded-full px-2.5 py-1 font-semibold ${confidenceTone(Number(currentEffectItem?.confidence || 0))}`}>
                confidence {(Number(currentEffectItem?.confidence || 0) * 100).toFixed(0)}%
              </span>
            </div>
          </>
        ) : (
          <>
            <StepProgressBar steps={steps} currentStepIndex={currentStepIndex} onStepClick={onStepClick} />
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 font-semibold text-emerald-300">완료 {resolvedCount}</span>
              <span className="rounded-full bg-slate-800 px-2.5 py-1 font-semibold text-slate-300">대기 {pendingCount}</span>
              {currentStep ? (
                <span className={`rounded-full px-2.5 py-1 font-semibold ${confidenceTone(Number(currentStep.confidence || 0))}`}>
                  confidence {(Number(currentStep.confidence || 0) * 100).toFixed(0)}%
                </span>
              ) : null}
            </div>
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-[#15161a] px-5 py-5">
        {messages.map((message) => (
          <ChatMessage
            key={message.id}
            role={message.role}
            content={message.content}
            timestamp={message.timestamp}
          />
        ))}

        {mode === 'cut' && currentCutItem ? (
          <div className="rounded-3xl border border-rose-500/20 bg-rose-950/25 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-rose-300">현재 컷 제안</p>
                <h3 className="mt-1 text-sm font-semibold text-white">
                  {formatMs(currentCutDraft?.start_ms ?? currentCutItem.proposal_start_ms)} ~ {formatMs(currentCutDraft?.end_ms ?? currentCutItem.proposal_end_ms)}
                </h3>
              </div>
              <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${confidenceTone(Number(currentCutItem.confidence || 0))}`}>
                {(Number(currentCutItem.confidence || 0) * 100).toFixed(0)}%
              </span>
            </div>
            <p className="mt-3 text-sm leading-6 text-slate-200">{currentCutItem.reason_text || '불필요 구간 후보입니다.'}</p>
            {(Number(currentCutDraft?.start_ms ?? currentCutItem.proposal_start_ms) !== Number(currentCutItem.proposal_start_ms)
              || Number(currentCutDraft?.end_ms ?? currentCutItem.proposal_end_ms) !== Number(currentCutItem.proposal_end_ms)) ? (
              <p className="mt-2 text-xs font-medium text-cyan-300">
                조정된 구간: {formatMs(currentCutDraft?.start_ms)} ~ {formatMs(currentCutDraft?.end_ms)}
              </p>
            ) : null}
            {currentCutItem.scene?.description ? (
              <p className="mt-2 text-xs leading-5 text-slate-400">장면 설명: {currentCutItem.scene.description}</p>
            ) : null}
            <div className="mt-4 grid gap-2">
              <button
                type="button"
                disabled={cutActionDisabled}
                onClick={() => onCutConfirm?.(currentCutItem.item_index)}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-slate-950 disabled:bg-slate-700 disabled:text-slate-400"
              >
                <CheckCircle2 className="h-4 w-4" />
                제안 적용
              </button>
              <button
                type="button"
                disabled={cutActionDisabled}
                onClick={() => onCutSkip?.(currentCutItem.item_index)}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-[#212329] px-4 py-2.5 text-sm font-medium text-slate-200 disabled:bg-slate-800"
              >
                <SkipForward className="h-4 w-4" />
                이 제안 건너뛰기
              </button>
            </div>
          </div>
        ) : null}

        {mode === 'effect' && currentEffectItem ? (
          <div className="rounded-3xl border border-cyan-500/20 bg-cyan-950/20 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-cyan-300">현재 효과 제안</p>
                <h3 className="mt-1 text-sm font-semibold text-white">{currentEffectItem.effect?.effect_label || '효과 삽입'}</h3>
              </div>
              <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${confidenceTone(Number(currentEffectItem.confidence || 0))}`}>
                {(Number(currentEffectItem.confidence || 0) * 100).toFixed(0)}%
              </span>
            </div>
            <p className="mt-3 text-sm leading-6 text-slate-200">{currentEffectItem.proposal?.reason || '효과 삽입 후보입니다.'}</p>
            {currentEffectItem.effect?.target_hint ? (
              <p className="mt-2 text-xs leading-5 text-slate-400">강조 포인트: {currentEffectItem.effect.target_hint}</p>
            ) : null}
            <div className="mt-4 grid gap-2">
              <button
                type="button"
                disabled={effectActionDisabled}
                onClick={() => onEffectConfirm?.(currentEffectItem.step_index)}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-slate-950 disabled:bg-slate-700 disabled:text-slate-400"
              >
                <CheckCircle2 className="h-4 w-4" />
                제안 적용
              </button>
              <button
                type="button"
                disabled={effectActionDisabled}
                onClick={() => onEffectSkip?.(currentEffectItem.step_index)}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-[#212329] px-4 py-2.5 text-sm font-medium text-slate-200 disabled:bg-slate-800"
              >
                <SkipForward className="h-4 w-4" />
                이 제안 건너뛰기
              </button>
            </div>
          </div>
        ) : null}

        {mode !== 'cut' && currentStep ? (
          <div className="rounded-3xl border border-slate-800 bg-[#202229] p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">현재 스텝</p>
                <h3 className="mt-1 text-sm font-semibold text-white">{stepTypeLabel(currentStep.step_type)}</h3>
              </div>
              {currentStep.auto_confirm ? (
                <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-300">자동 컨펌 후보</span>
              ) : null}
            </div>
            <div className="mt-4 grid gap-2">
              <button
                type="button"
                disabled={actionDisabled}
                onClick={() => onConfirm?.(currentStep.step_index)}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-slate-950 disabled:bg-slate-700 disabled:text-slate-400"
              >
                <CheckCircle2 className="h-4 w-4" />
                컨펌
              </button>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={actionDisabled}
                  onClick={() => onSkip?.(currentStep.step_index)}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-[#212329] px-4 py-2.5 text-sm font-medium text-slate-200 disabled:bg-slate-800"
                >
                  <SkipForward className="h-4 w-4" />
                  건너뛰기
                </button>
                <button
                  type="button"
                  disabled={actionDisabled || !currentStep.blue}
                  onClick={() => onAdoptBlue?.(currentStep.step_index)}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-2.5 text-sm font-medium text-cyan-300 disabled:opacity-50"
                >
                  <Sparkles className="h-4 w-4" />
                  BLUE 채택
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="border-t border-slate-800 bg-[#1b1c1f] px-5 py-4">
        <div className="rounded-3xl border border-slate-700 bg-[#22242a] p-3 shadow-sm">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={3}
            placeholder={mode === 'cut'
              ? '예: 00:45부터는 남기고 00:49부터 잘라줘, 이 구간은 삭제하지 말아줘'
              : mode === 'effect'
                ? '예: 이 구간은 확대보다 포인터가 더 자연스러워, 전환은 부드럽게 바꿔줘'
                : '예: 00:45부터 삭제로 바꿔줘, 이 구간은 장면 전환을 더 부드럽게 해줘'}
            className="w-full resize-none border-none bg-transparent px-1 py-1 text-sm text-slate-100 outline-none placeholder:text-slate-500"
          />
          {mode === 'cut' ? (
            <div className="mt-3 space-y-3">
              <p className="text-xs text-slate-500">
                컷 제안 보정 메모를 남기면 현재 선택 구간을 수정 상태로 기록합니다.
              </p>
              <div className="grid gap-2">
                <button
                  type="button"
                  disabled={!currentCutItem || !prompt.trim() || loading}
                  onClick={() => {
                    onCutModify?.(currentCutItem.item_index, {
                      reason: prompt.trim(),
                      operator_note: prompt.trim(),
                    });
                    setPrompt('');
                  }}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-violet-500 px-4 py-2.5 text-sm font-semibold text-white disabled:bg-slate-700 disabled:text-slate-400"
                >
                  <Send className="h-4 w-4" />
                  수정 전송
                </button>
                <button
                  type="button"
                  disabled={loading || !canFinalizeCut}
                  onClick={onCutFinalize}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-400 px-4 py-2.5 text-sm font-semibold text-slate-950 disabled:bg-slate-700 disabled:text-slate-400"
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />}
                  컷 편집 확정
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-xs text-slate-500">
                {mode === 'effect'
                  ? '효과 제안 보정 메모를 남기면 현재 선택 구간의 효과 타입/이유를 수정 상태로 기록합니다.'
                  : '현재 스텝에 대한 수정 메모를 직접 남길 수 있습니다.'}
              </p>
              <div className="flex items-center gap-2">
                {mode === 'effect' ? (
                  <button
                    type="button"
                    disabled={loading || !canFinalizeEffect}
                    onClick={onEffectFinalize}
                    className="inline-flex items-center gap-2 rounded-xl bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:bg-slate-700 disabled:text-slate-400"
                  >
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                    효과 삽입 확정
                  </button>
                ) : null}
                {mode !== 'cut' && canFinalize ? (
                  <button
                    type="button"
                    disabled={loading}
                    onClick={onFinalize}
                    className="inline-flex items-center gap-2 rounded-xl bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:bg-slate-700 disabled:text-slate-400"
                  >
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                    프리뷰 렌더링
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={(mode === 'effect' ? !currentEffectItem : !currentStep) || !prompt.trim() || loading}
                  onClick={() => {
                    if (mode === 'effect') {
                      onEffectModify?.(currentEffectItem.step_index, {
                        reason: prompt.trim(),
                        operator_note: prompt.trim(),
                      });
                    } else {
                      onModify?.(currentStep.step_index, {
                        reason: prompt.trim(),
                        operator_note: prompt.trim(),
                      });
                    }
                    setPrompt('');
                  }}
                  className="inline-flex items-center gap-2 rounded-xl bg-violet-500 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-700 disabled:text-slate-400"
                >
                  <Send className="h-4 w-4" />
                  수정 전송
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
