'use client';

export default function ProposalFlowActions({
  onPromptFill,
  onJumpToInput,
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={onPromptFill}
        className="rounded-full bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
      >
        프롬프트에 채우기
      </button>
      <button
        type="button"
        onClick={onJumpToInput}
        className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
      >
        입력 위치로 이동
      </button>
    </div>
  );
}
