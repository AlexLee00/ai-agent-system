'use client';

import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { api } from '@/lib/api';
import VideoChatWorkflow from '@/components/VideoChatWorkflow';
import VideoHistoryPanel from '@/components/VideoHistoryPanel';

export default function VideoPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedSessionId = useMemo(() => {
    const raw = String(searchParams?.get('session') || '').trim();
    return raw ? Number(raw) : null;
  }, [searchParams]);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [workflowResetToken, setWorkflowResetToken] = useState(0);

  function handleCreate() {
    router.replace('/video');
    setWorkflowResetToken((prev) => prev + 1);
  }

  function handleSelect(session) {
    if (session?.latest_edit_id && session.latest_edit_mode === 'interactive') {
      router.push(`/video/editor?editId=${session.latest_edit_id}`);
      return;
    }
    router.replace(`/video?session=${session.id}`);
  }

  async function handleDelete(session) {
    if (!session?.latest_edit_id) {
      throw new Error('삭제할 편집 이력이 없습니다.');
    }
    await api.delete(`/video/edits/${session.latest_edit_id}`);
    setHistoryRefreshKey((prev) => prev + 1);
    if (Number(selectedSessionId || 0) === Number(session.id || 0)) {
      router.replace('/video');
      setWorkflowResetToken((prev) => prev + 1);
    }
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col gap-4 p-4 lg:flex-row">
      <div className="h-[320px] shrink-0 overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm lg:h-full lg:w-80">
        <VideoHistoryPanel
          selectedSessionId={selectedSessionId}
          onSelect={handleSelect}
          onDelete={handleDelete}
          onCreate={handleCreate}
          refreshKey={historyRefreshKey}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
        <VideoChatWorkflow
          key={`${selectedSessionId || 'new'}-${workflowResetToken}`}
          sessionId={selectedSessionId}
          resetToken={workflowResetToken}
          onEditStart={(editId) => {
            setHistoryRefreshKey((prev) => prev + 1);
            router.push(`/video/editor?editId=${editId}`);
          }}
          onSessionChange={() => setHistoryRefreshKey((prev) => prev + 1)}
        />
      </div>
    </div>
  );
}
