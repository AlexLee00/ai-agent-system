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
