'use client';

export default function AdminPageHero({ title, description, badge, stats = [], tone = 'slate' }) {
  const toneClass =
    tone === 'amber'
      ? 'from-amber-50 to-white'
      : tone === 'indigo'
        ? 'from-indigo-50 to-white'
        : 'from-white to-slate-100/80';

  return (
    <section className={`card overflow-hidden bg-gradient-to-br ${toneClass}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold text-slate-900">{title}</h1>
            {badge ? (
              <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700">
                {badge}
              </span>
            ) : null}
          </div>
          {description ? <p className="mt-2 text-sm text-slate-500">{description}</p> : null}
        </div>

        {stats.length ? (
          <div
            className={`grid min-w-[260px] gap-3 ${
              stats.length >= 3 ? 'grid-cols-3' : stats.length === 2 ? 'grid-cols-2' : 'grid-cols-1'
            }`}
          >
            {stats.map((item) => (
              <div key={item.label} className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
                <p className="text-xs text-slate-500">{item.label}</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">{item.value}</p>
                {item.caption ? <p className="mt-2 text-xs text-slate-400">{item.caption}</p> : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
