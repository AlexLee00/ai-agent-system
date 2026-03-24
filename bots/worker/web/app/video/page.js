'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { History, Plus } from 'lucide-react';

import VideoChatWorkflow from '@/components/VideoChatWorkflow';

export default function VideoPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedSessionId = useMemo(() => {
    const raw = String(searchParams?.get('session') || '').trim();
    return raw ? Number(raw) : null;
  }, [searchParams]);
  const [workflowResetToken, setWorkflowResetToken] = useState(0);
  const [isMobileViewport, setIsMobileViewport] = useState(false);

  useEffect(() => {
    function syncViewport() {
      setIsMobileViewport(window.innerWidth < 1024);
    }
    syncViewport();
    window.addEventListener('resize', syncViewport);
    return () => window.removeEventListener('resize', syncViewport);
  }, []);

  function handleCreate() {
    router.replace('/video');
    setWorkflowResetToken((prev) => prev + 1);
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col gap-4 p-4">
      <div className="flex items-center justify-between rounded-[28px] border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-500">AI Chat Workflow</p>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">대화형 영상 설정</h1>
          <p className="mt-1 text-sm text-slate-500">AI와 대화하며 업로드, 인트로/아웃트로, 편집 의도를 설정한 뒤 편집기로 이동합니다.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCreate}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <Plus className="h-4 w-4" />
            새 편집
          </button>
          <Link
            href="/video/history"
            className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-slate-200 text-slate-700 transition hover:bg-slate-50"
            aria-label="편집 이력 보기"
            title="편집 이력"
          >
            <History className="h-5 w-5" />
          </Link>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
        {isMobileViewport ? (
          <div className="flex h-full items-center justify-center px-6 py-10 text-center">
            <div className="max-w-md rounded-3xl border border-amber-200 bg-amber-50 px-6 py-8">
              <p className="text-sm font-semibold text-amber-700">PC 전용 메뉴입니다.</p>
              <p className="mt-2 text-sm leading-6 text-amber-800">영상 편집 기능은 PC에서 이용해주세요.</p>
            </div>
          </div>
        ) : (
          <VideoChatWorkflow
            key={`${selectedSessionId || 'new'}-${workflowResetToken}`}
            sessionId={selectedSessionId}
            resetToken={workflowResetToken}
            onEditStart={(editId) => {
              router.push(`/video/editor?editId=${editId}`);
            }}
            onSessionChange={() => {}}
          />
        )}
      </div>
    </div>
  );
}
