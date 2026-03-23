'use client';

function getStepState(step, index, currentStepIndex) {
  if (step?.user_action) {
    return step.auto_confirm ? 'auto' : 'done';
  }
  if (index === currentStepIndex) return 'current';
  return 'pending';
}

export default function StepProgressBar({
  steps = [],
  currentStepIndex = 0,
  onStepClick = null,
}) {
  if (!Array.isArray(steps) || !steps.length) return null;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-semibold text-slate-900">스텝 진행 상황</p>
        <p className="text-xs text-slate-500">
          {Math.min(currentStepIndex + 1, steps.length)} / {steps.length}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {steps.map((step, index) => {
          const state = getStepState(step, index, currentStepIndex);
          const baseClass = 'inline-flex h-7 min-w-7 items-center justify-center rounded-full border px-2 text-[11px] font-semibold transition';
          const stateClass = state === 'done'
            ? 'border-emerald-300 bg-emerald-500 text-white'
            : state === 'auto'
              ? 'border-emerald-200 bg-emerald-100 text-emerald-700'
              : state === 'current'
                ? 'border-violet-300 bg-violet-600 text-white'
                : 'border-slate-200 bg-slate-100 text-slate-500';

          return (
            <button
              key={`${step.step_index}-${step.step_type}`}
              type="button"
              className={`${baseClass} ${stateClass}`}
              onClick={() => onStepClick?.(index)}
              disabled={!onStepClick}
              title={`#${index + 1} ${step.step_type}`}
            >
              <span className="mr-1">{state === 'pending' ? '○' : '●'}</span>
              {index + 1}
            </button>
          );
        })}
      </div>
    </div>
  );
}
