// @ts-nocheck
'use client';

export default function Card({ title, value, subtitle, icon, color = 'blue', onClick }) {
  const colors = {
    blue:   'bg-sky-50 text-sky-700',
    green:  'bg-emerald-50 text-emerald-700',
    yellow: 'bg-amber-50 text-amber-700',
    red:    'bg-rose-50 text-rose-700',
  };

  return (
    <div
      className={`card transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 ${
        onClick ? 'cursor-pointer' : ''
      }`}
      onClick={onClick}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-slate-500 font-medium">{title}</p>
          <p className="text-2xl font-semibold text-slate-900 mt-1">{value ?? '-'}</p>
          {subtitle && <p className="text-xs text-slate-400 mt-2">{subtitle}</p>}
        </div>
        {icon && (
          <div className={`w-11 h-11 rounded-2xl flex items-center justify-center text-xl ${colors[color]}`}>
            {icon}
          </div>
        )}
      </div>
    </div>
  );
}
