'use client';

export default function PendingReviewSection({
  description,
  hasPending,
  children,
  title = '확인 및 승인 대기',
  badgeLabel,
}) {
  return (
    <div className="card space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-slate-500">{title}</p>
          <p className="text-sm text-slate-600 mt-1">{description}</p>
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
          {badgeLabel || (hasPending ? '대기 중 1건' : '최근 처리 완료')}
        </span>
      </div>
      {children}
    </div>
  );
}
