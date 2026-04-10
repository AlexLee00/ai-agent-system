'use client';

export default function DotCharacter({
  color = '#6366f1',
  accessory = 'none',
  status = 'idle',
  size = 48,
}) {
  const eyeColor = '#1e293b';
  const highlight = `${color}88`;

  const animCls = {
    active: 'animate-agent-float',
    idle: 'animate-pulse',
    learning: 'animate-agent-spin-slow',
    archived: 'opacity-40',
  }[status] || '';

  return (
    <div
      className={`inline-flex items-center justify-center ${animCls}`}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
        <rect x="8" y="10" width="16" height="14" rx="4" fill={color} />
        <rect x="6" y="4" width="20" height="14" rx="6" fill={color} />
        <rect x="8" y="5" width="16" height="6" rx="4" fill={highlight} />

        <circle cx="12" cy="12" r="2" fill="white" />
        <circle cx="20" cy="12" r="2" fill="white" />
        <circle cx="12.5" cy="12" r="1" fill={eyeColor} />
        <circle cx="20.5" cy="12" r="1" fill={eyeColor} />
        <path d="M13 16 Q16 18 19 16" stroke={eyeColor} strokeWidth="0.8" fill="none" />

        <rect x="10" y="23" width="4" height="3" rx="1" fill={color} />
        <rect x="18" y="23" width="4" height="3" rx="1" fill={color} />

        {accessory === 'glasses' ? (
          <>
            <circle cx="12" cy="12" r="3.5" stroke="#475569" strokeWidth="0.8" fill="none" />
            <circle cx="20" cy="12" r="3.5" stroke="#475569" strokeWidth="0.8" fill="none" />
            <line x1="15.5" y1="11.5" x2="16.5" y2="11.5" stroke="#475569" strokeWidth="0.8" />
          </>
        ) : null}

        {accessory === 'crown' ? (
          <polygon points="10,4 12,1 14,3 16,0 18,3 20,1 22,4" fill="#f59e0b" stroke="#d97706" strokeWidth="0.3" />
        ) : null}

        {accessory === 'pen' ? (
          <line x1="24" y1="8" x2="28" y2="2" stroke="#475569" strokeWidth="1.2" strokeLinecap="round" />
        ) : null}

        {accessory === 'shield' ? (
          <path d="M14,2 L18,2 L19,6 L16,8 L13,6 Z" fill="#64748b" stroke="#475569" strokeWidth="0.3" />
        ) : null}

        {accessory === 'chart' ? (
          <g transform="translate(22,4)">
            <rect x="0" y="4" width="2" height="4" fill="#10b981" />
            <rect x="3" y="2" width="2" height="6" fill="#3b82f6" />
            <rect x="6" y="0" width="2" height="8" fill="#f59e0b" />
          </g>
        ) : null}

        {accessory === 'book' ? (
          <rect x="23" y="6" width="6" height="8" rx="1" fill="#a855f7" stroke="#7c3aed" strokeWidth="0.3" />
        ) : null}

        {accessory === 'magnifier' ? (
          <g transform="translate(22,3)">
            <circle cx="3" cy="3" r="2.5" stroke="#475569" strokeWidth="0.8" fill="none" />
            <line x1="5" y1="5" x2="7" y2="7" stroke="#475569" strokeWidth="1" />
          </g>
        ) : null}

        {accessory === 'compass' ? (
          <g transform="translate(22,3)">
            <circle cx="3" cy="3" r="3" stroke="#ef4444" strokeWidth="0.6" fill="none" />
            <polygon points="3,0.5 4,3 3,5.5 2,3" fill="#ef4444" />
          </g>
        ) : null}

        {accessory === 'cross' ? (
          <g transform="translate(23,3)">
            <rect x="2" y="0" width="2" height="6" fill="#ef4444" />
            <rect x="0" y="2" width="6" height="2" fill="#ef4444" />
          </g>
        ) : null}
      </svg>
    </div>
  );
}
