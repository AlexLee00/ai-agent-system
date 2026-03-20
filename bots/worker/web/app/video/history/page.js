'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Clock3, Download, History, Video } from 'lucide-react';

import DataTable from '@/components/DataTable';
import { api } from '@/lib/api';
import { getToken } from '@/lib/auth-context';

function formatDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('ko-KR');
}

function statusBadge(status) {
  const styles = {
    idle: 'bg-slate-100 text-slate-700',
    uploaded: 'bg-blue-50 text-blue-700',
    processing: 'bg-amber-50 text-amber-700',
    preview_ready: 'bg-indigo-50 text-indigo-700',
    rendering: 'bg-violet-50 text-violet-700',
    done: 'bg-emerald-50 text-emerald-700',
    failed: 'bg-rose-50 text-rose-700',
  };
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${styles[status] || styles.idle}`}>
      {status}
    </span>
  );
}

async function downloadProtectedFile(url, filename) {
  const token = getToken();
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    throw new Error(payload.error || '다운로드에 실패했습니다.');
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export default function VideoHistoryPage() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api.get('/video/sessions')
      .then((data) => {
        if (!alive) return;
        setSessions(data.sessions || []);
      })
      .catch((fetchError) => {
        if (!alive) return;
        setError(fetchError.message);
      })
      .finally(() => {
        if (!alive) return;
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const columns = [
    { key: 'title', label: '제목', render: (value, row) => value || `세션 #${row.id}` },
    { key: 'status', label: '상태', render: (value) => statusBadge(value) },
    { key: 'uploaded_file_count', label: '파일 수' },
    { key: 'total_size_mb', label: '크기', render: (value) => `${Number(value || 0).toFixed(2)}MB` },
    { key: 'created_at', label: '생성일', render: (value) => formatDate(value) },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
              <History className="h-3.5 w-3.5" />
              영상 편집 이력
            </p>
            <h1 className="mt-3 text-2xl font-bold text-slate-900">편집 이력</h1>
            <p className="mt-1 text-sm text-slate-500">세션별 상태와 다운로드 가능 여부를 확인합니다.</p>
          </div>
          <Link href="/video" className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white">
            <Video className="h-4 w-4" />
            새 편집 시작
          </Link>
        </div>
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        {loading ? (
          <div className="py-16 text-center text-slate-400">
            <Clock3 className="mx-auto h-8 w-8 animate-pulse" />
            <p className="mt-3 text-sm">편집 이력을 불러오는 중입니다.</p>
          </div>
        ) : error ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>
        ) : (
          <DataTable
            columns={columns}
            data={sessions}
            pageSize={10}
            emptyText="아직 영상 편집 세션이 없습니다."
            actions={(row) => (
              <>
                <Link href={`/video?session=${row.id}`} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700">
                  상세 보기
                </Link>
                {row.status === 'done' ? (
                  <button
                    type="button"
                    onClick={() => downloadProtectedFile(`/api/video/sessions/${row.id}/download-all`, `video-session-${row.id}.zip`)}
                    className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 px-3 py-2 text-xs font-medium text-emerald-700"
                  >
                    <Download className="h-3.5 w-3.5" />
                    ZIP
                  </button>
                ) : null}
              </>
            )}
            mobileRowRender={(row, actions) => (
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{row.title || `세션 #${row.id}`}</p>
                    <p className="mt-1 text-xs text-slate-500">{formatDate(row.created_at)}</p>
                  </div>
                  {statusBadge(row.status)}
                </div>
                <div className="grid grid-cols-2 gap-3 text-xs text-slate-500">
                  <div>파일 수: {row.uploaded_file_count || 0}</div>
                  <div>크기: {Number(row.total_size_mb || 0).toFixed(2)}MB</div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {actions(row)}
                </div>
              </div>
            )}
          />
        )}
      </div>
    </div>
  );
}
