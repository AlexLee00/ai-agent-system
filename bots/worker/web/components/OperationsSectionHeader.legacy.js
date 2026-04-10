'use client';

export default function OperationsSectionHeader({
  eyebrow,
  title,
  description,
  right,
  className = '',
}) {
  return (
    <div className={`flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between ${className}`.trim()}>
      <div className="min-w-0">
        {eyebrow ? <p className="text-sm font-medium text-slate-500">{eyebrow}</p> : null}
        {title ? <h2 className="mt-1 text-lg font-semibold text-slate-900">{title}</h2> : null}
        {description ? (
          <p className="mt-1 text-xs leading-relaxed text-slate-400 break-keep">
            {description}
          </p>
        ) : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}
