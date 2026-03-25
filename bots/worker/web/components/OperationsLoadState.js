'use client';

export function OperationsLoadAlert({
  error,
  onRetry,
  className = '',
}) {
  if (!error) return null;
  return (
    <div className={`flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 sm:flex-row sm:items-center sm:justify-between ${className}`.trim()}>
      <p>{error}</p>
      {typeof onRetry === 'function' ? (
        <button
          type="button"
          className="inline-flex self-start rounded-xl border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-800 transition hover:bg-amber-100"
          onClick={onRetry}
        >
          다시 시도
        </button>
      ) : null}
    </div>
  );
}

export function OperationsLoadingPlaceholder({
  label = '로딩 중...',
  className = '',
}) {
  return (
    <p className={`py-10 text-center text-sm text-gray-400 ${className}`.trim()}>
      {label}
    </p>
  );
}

export function OperationsEmptyState({
  icon = '📭',
  title = '아직 데이터가 없습니다.',
  description = '',
  actionLabel,
  onAction,
  className = '',
}) {
  return (
    <div className={`text-center py-12 ${className}`.trim()}>
      <p className="mb-3 text-4xl">{icon}</p>
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {description ? (
        <p className="mt-2 text-sm text-gray-500">{description}</p>
      ) : null}
      {actionLabel && typeof onAction === 'function' ? (
        <button type="button" onClick={onAction} className="btn-primary mt-4 text-sm">
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

export function OperationsNotice({
  message,
  tone = 'success',
  className = '',
}) {
  if (!message) return null;
  const toneMap = {
    success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    info: 'border-sky-200 bg-sky-50 text-sky-700',
    warn: 'border-amber-200 bg-amber-50 text-amber-800',
  };
  return (
    <div className={`rounded-2xl border px-4 py-3 text-sm ${toneMap[tone] || toneMap.success} ${className}`.trim()}>
      {message}
    </div>
  );
}
