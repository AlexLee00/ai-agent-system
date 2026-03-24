'use client';

import {
  AlertCircle,
  Bot,
  Sparkles,
  UserCircle2,
} from 'lucide-react';

function formatTimestamp(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function resolveTone(role) {
  if (role === 'user') {
    return {
      wrapper: 'justify-end',
      bubble: 'bg-violet-600 text-white rounded-tr-md',
      iconWrap: 'bg-violet-100 text-violet-700',
      icon: UserCircle2,
      label: '사용자',
      time: 'text-violet-100/80',
    };
  }
  if (role === 'red') {
    return {
      wrapper: 'justify-start',
      bubble: 'bg-rose-50 text-rose-900 border border-rose-200 rounded-tl-md',
      iconWrap: 'bg-rose-100 text-rose-700',
      icon: AlertCircle,
      label: 'RED',
      time: 'text-rose-400',
    };
  }
  if (role === 'blue') {
    return {
      wrapper: 'justify-start',
      bubble: 'bg-blue-50 text-blue-900 border border-blue-200 rounded-tl-md',
      iconWrap: 'bg-blue-100 text-blue-700',
      icon: Sparkles,
      label: 'BLUE',
      time: 'text-blue-400',
    };
  }
  if (role === 'system') {
    return {
      wrapper: 'justify-center',
      bubble: 'bg-slate-100 text-slate-600 border border-slate-200 rounded-2xl',
      iconWrap: 'bg-slate-200 text-slate-600',
      icon: Bot,
      label: '시스템',
      time: 'text-slate-400',
    };
  }
  return {
    wrapper: 'justify-start',
    bubble: 'bg-slate-100 text-slate-800 rounded-tl-md',
    iconWrap: 'bg-violet-100 text-violet-700',
    icon: Bot,
    label: 'AI',
    time: 'text-slate-400',
  };
}

export default function ChatMessage({
  role = 'ai',
  content = '',
  timestamp = '',
  footer = null,
  children = null,
}) {
  const tone = resolveTone(role);
  const Icon = tone.icon;

  return (
    <div className={`flex gap-3 ${tone.wrapper}`}>
      {role === 'user' ? null : (
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${tone.iconWrap}`}>
          <Icon className="h-4.5 w-4.5" />
        </div>
      )}
      <div className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-6 shadow-sm ${tone.bubble}`}>
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] opacity-80">
          <span>{tone.label}</span>
          {timestamp ? <span className={tone.time}>{formatTimestamp(timestamp)}</span> : null}
        </div>
        <div className="mt-1 whitespace-pre-wrap break-words">{content}</div>
        {children ? <div className="mt-3">{children}</div> : null}
        {footer ? <div className="mt-3">{footer}</div> : null}
      </div>
      {role === 'user' ? (
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${tone.iconWrap}`}>
          <Icon className="h-4.5 w-4.5" />
        </div>
      ) : null}
    </div>
  );
}
