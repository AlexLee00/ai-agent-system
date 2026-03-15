'use client';

import ProposalFlowActions from '@/components/ProposalFlowActions';

export default function AdminQuickFlowGrid({ items = [] }) {
  if (!items.length) return null;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {items.map((item) => (
        <div key={item.title} className="card space-y-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">{item.title}</h2>
            <p className="mt-1 text-sm text-slate-500">{item.body}</p>
          </div>
          <ProposalFlowActions
            onPromptFill={item.onPromptFill}
            onSecondary={item.onSecondary}
            secondaryLabel={item.secondaryLabel || '관련 화면 열기'}
          />
        </div>
      ))}
    </div>
  );
}
