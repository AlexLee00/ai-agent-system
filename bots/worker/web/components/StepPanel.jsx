'use client';

import StepProgressBar from './StepProgressBar';

function confidenceTone(confidence = 0) {
  if (confidence >= 0.8) return 'bg-emerald-100 text-emerald-700 border-emerald-200';
  if (confidence >= 0.5) return 'bg-amber-100 text-amber-700 border-amber-200';
  return 'bg-rose-100 text-rose-700 border-rose-200';
}

function confidenceLabel(confidence = 0) {
  if (confidence >= 0.8) return 'high';
  if (confidence >= 0.5) return 'medium';
  return 'low';
}

function renderMatchSummary(step) {
  const narrationTopic = step?.proposal?.narration?.topic || '주제 없음';
  const sourceDescription = step?.proposal?.source?.description || '장면 설명 없음';
  return `${narrationTopic} ↔ ${sourceDescription}`;
}

export default function StepPanel({
  steps = [],
  currentStepIndex = 0,
  onStepClick,
  onConfirm,
  onModify,
  onSkip,
  onAdoptBlue,
  onFinalize,
  loading = false,
}) {
  const currentStep = steps[currentStepIndex] || null;
  const allHandled = steps.length > 0 && steps.every((step) => Boolean(step.user_action));

  const handleModifyClick = () => {
    if (!currentStep || typeof onModify !== 'function') return;
    const nextReason = window.prompt(
      '수정 사유 또는 새로운 설명을 입력하세요.',
      currentStep.proposal?.reason || currentStep.proposal?.source?.description || ''
    );
    if (nextReason == null) return;
    onModify(currentStep.step_index, { reason: nextReason.trim() || currentStep.proposal?.reason || '' });
  };

  return (
    <div className="flex h-full flex-col bg-slate-50">
      <div className="border-b border-slate-200 px-4 py-4">
        <p className="text-sm font-semibold text-slate-900">AI 편집 어시스턴트</p>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          스텝별 AI 제안, RED 평가, BLUE 대안, 사용자 판단을 여기서 처리합니다.
        </p>
      </div>

      <div className="border-b border-slate-200 px-4 py-4">
        <StepProgressBar
          steps={steps}
          currentStepIndex={currentStepIndex}
          onStepClick={onStepClick}
        />
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {!currentStep ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
            아직 로드된 편집 스텝이 없습니다. editId를 입력하고 세션을 시작하세요.
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Step #{currentStep.step_index + 1} · {currentStep.step_type}
                  </p>
                  <p className="mt-2 text-sm font-semibold text-slate-900">
                    {currentStep.proposal?.reason || '설명 없음'}
                  </p>
                </div>
                <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${confidenceTone(currentStep.confidence)}`}>
                  {confidenceLabel(currentStep.confidence)} · {Number(currentStep.confidence || 0).toFixed(2)}
                </span>
              </div>

              <div className="mt-4 space-y-2 rounded-xl bg-slate-50 p-3">
                <p className="text-xs font-medium text-slate-500">매칭 정보</p>
                <p className="text-sm font-medium text-slate-800">{renderMatchSummary(currentStep)}</p>
                <p className="text-xs text-slate-500">
                  나레이션 구간 {Number(currentStep.proposal?.narration?.start_s || 0).toFixed(1)}s ~ {Number(currentStep.proposal?.narration?.end_s || 0).toFixed(1)}s
                </p>
              </div>

              {currentStep.auto_confirm ? (
                <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                  자동 컨펌 대상 스텝입니다.
                  {currentStep.user_action ? ' 이미 자동 컨펌되었습니다.' : ' 필요 시 수동 수정/건너뛰기가 가능합니다.'}
                </div>
              ) : null}
            </div>

            {currentStep.red ? (
              <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-rose-600">RED 평가</p>
                <p className="mt-2 text-sm font-semibold text-rose-900">점수: {currentStep.red.score}</p>
                <p className="mt-1 text-sm leading-6 text-rose-800">{currentStep.red.comment}</p>
              </div>
            ) : null}

            {currentStep.blue ? (
              <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-sky-700">BLUE 대안</p>
                <p className="mt-2 text-sm font-semibold text-sky-900">
                  점수: {currentStep.blue.score} · {currentStep.blue.reason}
                </p>
                <p className="mt-1 text-sm leading-6 text-sky-800">
                  {currentStep.blue.alternative_source?.description || '대안 장면 설명 없음'}
                </p>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="border-t border-slate-200 bg-white px-4 py-4">
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className="rounded-xl bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            onClick={() => currentStep && onConfirm?.(currentStep.step_index)}
            disabled={!currentStep || loading}
          >
            컨펌
          </button>
          <button
            type="button"
            className="rounded-xl bg-amber-500 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            onClick={handleModifyClick}
            disabled={!currentStep || loading}
          >
            수정
          </button>
          <button
            type="button"
            className="rounded-xl bg-slate-600 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            onClick={() => currentStep && onSkip?.(currentStep.step_index)}
            disabled={!currentStep || loading}
          >
            건너뛰기
          </button>
          <button
            type="button"
            className="rounded-xl bg-sky-600 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            onClick={() => currentStep && onAdoptBlue?.(currentStep.step_index)}
            disabled={!currentStep || !currentStep.blue || loading}
          >
            BLUE 채택
          </button>
        </div>

        <button
          type="button"
          className="mt-3 w-full rounded-xl border border-slate-300 bg-slate-900 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
          onClick={() => onFinalize?.()}
          disabled={!allHandled || loading}
        >
          편집 완료
        </button>
      </div>
    </div>
  );
}
