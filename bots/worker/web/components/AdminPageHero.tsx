// @ts-nocheck
'use client';

import Link from 'next/link';

export default function AdminPageHero({
  title,
  description,
  badge,
  stats = [],
  tone = 'slate',
  children = null,
}) {
  const toneClass =
    tone === 'amber'
      ? 'from-amber-50 to-white'
      : tone === 'indigo'
        ? 'from-indigo-50 to-white'
        : 'from-white to-slate-100/80';

  return (
    <section className={`card overflow-hidden bg-gradient-to-br ${toneClass}`}>
      <div className="space-y-4">
        <div className="max-w-3xl">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <h1 className="text-lg font-bold text-slate-900 sm:text-xl">{title}</h1>
            {badge ? (
              <span className="max-w-full self-start break-keep rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700">
                {badge}
              </span>
            ) : null}
          </div>
          {description ? <p className="mt-2 text-sm leading-relaxed text-slate-500 break-keep">{description}</p> : null}
        </div>

        {stats.length ? (
          <div
            className={`grid gap-3 ${
              stats.length >= 4
                ? 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-4'
                : stats.length === 3
                  ? 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3'
                  : stats.length === 2
                    ? 'grid-cols-1 sm:grid-cols-2'
                    : 'grid-cols-1'
            }`}
          >
            {stats.map((item) => (
              <div key={item.label} className="rounded-3xl border border-slate-200 bg-white px-4 py-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <p className="min-w-0 text-sm font-medium text-slate-500 break-keep">{item.label}</p>
                  {item.actionHref && item.actionLabel ? (
                    <Link
                      href={item.actionHref}
                      className="inline-flex shrink-0 self-start whitespace-nowrap items-center rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-100"
                    >
                      {item.actionLabel}
                    </Link>
                  ) : null}
                </div>
                <p className="mt-2 text-2xl font-semibold text-slate-900">{item.value}</p>
                {(item.caption || item.body) ? (
                  <div className="mt-3 space-y-3">
                    {item.caption ? (
                      <p className="text-xs leading-relaxed text-slate-400 break-keep">{item.caption}</p>
                    ) : null}
                    {item.body ? (
                      <p className="text-sm leading-relaxed text-slate-500 break-keep">{item.body}</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {children ? <div>{children}</div> : null}
      </div>
    </section>
  );
}
