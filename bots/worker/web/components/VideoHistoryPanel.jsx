'use client';

import { useEffect, useState } from 'react';
import {
  ChevronRight,
  Film,
  Loader2,
  Plus,
  RefreshCcw,
  Trash2,
} from 'lucide-react';

import { api } from '@/lib/api';

function formatDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusStyle(status) {
  const map = {
    idle: 'bg-slate-100 text-slate-700',
    uploaded: 'bg-blue-50 text-blue-700',
    processing: 'bg-amber-50 text-amber-700',
    preview_ready: 'bg-violet-50 text-violet-700',
    rendering: 'bg-fuchsia-50 text-fuchsia-700',
    done: 'bg-emerald-50 text-emerald-700',
    failed: 'bg-rose-50 text-rose-700',
  };
  return map[status] || map.idle;
}

function modeStyle(mode) {
  return mode === 'interactive'
    ? 'bg-violet-50 text-violet-700'
    : 'bg-slate-100 text-slate-600';
}

export default function VideoHistoryPanel({
  selectedSessionId = null,
  onSelect,
  onDelete,
  onCreate,
  refreshKey = 0,
}) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyEditId, setBusyEditId] = useState(null);

  async function loadSessions() {
    setLoading(true);
    setError('');
    try {
      const data = await api.get('/video/sessions');
      setSessions(data.sessions || []);
    } catch (fetchError) {
      setError(fetchError.message || '편집 이력을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSessions();
  }, [refreshKey]);

  async function handleDelete(session) {
    if (!session?.latest_edit_id) return;
    const ok = window.confirm(`"${session.title || `편집 #${session.id}`}"의 최신 편집 이력을 삭제할까요?`);
    if (!ok) return;
    setBusyEditId(session.latest_edit_id);
    try {
      await onDelete?.(session);
      await loadSessions();
    } catch (error) {
      setError(error.message || '편집 이력 삭제에 실패했습니다.');
    } finally {
      setBusyEditId(null);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-200 px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Video Workspace</p>
            <h2 className="mt-1 text-lg font-semibold text-slate-900">편집 이력</h2>
          </div>
          <button
            type="button"
            onClick={onCreate}
            className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white"
          >
            <Plus className="h-4 w-4" />
            새 편집 시작
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 px-5 py-3 text-xs text-slate-500">
        <span>최근 세션과 인터랙티브 편집 이력을 불러옵니다.</span>
        <button
          type="button"
          onClick={loadSessions}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-slate-600 hover:bg-slate-50"
        >
          <RefreshCcw className="h-3.5 w-3.5" />
          새로고침
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {loading ? (
          <div className="flex h-full min-h-[220px] items-center justify-center text-slate-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : error ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>
        ) : !sessions.length ? (
          <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-5 py-8 text-center">
            <Film className="mx-auto h-8 w-8 text-slate-300" />
            <p className="mt-3 text-sm font-medium text-slate-700">아직 저장된 편집 이력이 없습니다.</p>
            <p className="mt-1 text-xs text-slate-500">새 편집을 시작하면 이곳에 세션 카드가 쌓입니다.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {sessions.map((session) => {
              const selected = Number(selectedSessionId || 0) === Number(session.id || 0);
              return (
                <div
                  key={session.id}
                  className={`rounded-3xl border px-4 py-4 shadow-sm transition ${
                    selected ? 'border-violet-300 bg-violet-50/60' : 'border-slate-200 bg-white hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-900">{session.title || `편집 #${session.id}`}</p>
                      <p className="mt-1 text-xs text-slate-500">{formatDate(session.created_at)}</p>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2 text-[11px] font-semibold">
                      <span className={`rounded-full px-2.5 py-1 ${statusStyle(session.status)}`}>{session.status}</span>
                      {session.latest_edit_mode ? (
                        <span className={`rounded-full px-2.5 py-1 ${modeStyle(session.latest_edit_mode)}`}>{session.latest_edit_mode}</span>
                      ) : null}
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-500">
                    <div className="rounded-2xl bg-slate-50 px-3 py-2">파일 {Number(session.uploaded_file_count || 0)}개</div>
                    <div className="rounded-2xl bg-slate-50 px-3 py-2">편집 {Number(session.edit_count || 0)}개</div>
                  </div>
                  <div className="mt-4 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onSelect?.(session)}
                      className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                      불러오기
                      <ChevronRight className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      disabled={!session.latest_edit_id || busyEditId === session.latest_edit_id}
                      onClick={() => handleDelete(session)}
                      className="inline-flex items-center justify-center rounded-xl border border-rose-200 px-3 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {busyEditId === session.latest_edit_id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
