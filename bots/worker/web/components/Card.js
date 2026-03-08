'use client';

export default function Card({ title, value, subtitle, icon, color = 'blue', onClick }) {
  const colors = {
    blue:   'bg-blue-50  text-blue-600',
    green:  'bg-green-50 text-green-600',
    yellow: 'bg-yellow-50 text-yellow-600',
    red:    'bg-red-50   text-red-600',
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
          <p className="text-sm text-gray-500 font-medium">{title}</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{value ?? '-'}</p>
          {subtitle && <p className="text-xs text-gray-400 mt-1">{subtitle}</p>}
        </div>
        {icon && (
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-xl ${colors[color]}`}>
            {icon}
          </div>
        )}
      </div>
    </div>
  );
}
