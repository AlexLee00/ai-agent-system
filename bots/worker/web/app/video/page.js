'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  ArrowDown, ArrowUp, CheckCircle2, Clock3, Download, Film, Loader2, MessageSquareText,
  PlayCircle, RefreshCcw, Sparkles, Upload, Video,
} from 'lucide-react';

import { api } from '@/lib/api';
import { getToken } from '@/lib/auth-context';

const PHASES = {
  idle: 'idle',
  uploading: 'uploading',
  uploaded: 'uploaded',
  processing: 'processing',
  preview_ready: 'preview_ready',
  confirming: 'confirming',
  rendering: 'rendering',
  done: 'done',
  failed: 'failed',
};

function formatDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('ko-KR');
}

function formatMs(ms) {
  const num = Number(ms || 0);
  if (!Number.isFinite(num) || num <= 0) return '-';
  const totalSeconds = Math.round(num / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}시간 ${minutes}분 ${seconds}초`;
  if (minutes > 0) return `${minutes}분 ${seconds}초`;
  return `${seconds}초`;
}

function formatTimestamp(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds || 0)));
  const hh = String(Math.floor(safe / 3600)).padStart(2, '0');
  const mm = String(Math.floor((safe % 3600) / 60)).padStart(2, '0');
  const ss = String(safe % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function addMessage(setMessages, payload) {
  setMessages((prev) => [
    ...prev,
    {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      ...payload,
    },
  ]);
}

async function fetchProtectedBlob(url) {
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
    throw new Error(payload.error || '보호된 파일을 불러오지 못했습니다.');
  }
  return response.blob();
}

async function downloadProtectedFile(url, filename) {
  const blob = await fetchProtectedBlob(url);
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function ChatBubble({ msg }) {
  const isUser = msg.type === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-3xl rounded-2xl px-4 py-3 shadow-sm ${
        isUser ? 'bg-indigo-600 text-white' : 'bg-white text-slate-800 border border-slate-200'
      }`}>
        <p className="whitespace-pre-wrap text-sm leading-6">{msg.content}</p>
        {msg.component ? <div className="mt-3">{msg.component}</div> : null}
        <p className={`mt-2 text-[11px] ${isUser ? 'text-indigo-100' : 'text-slate-400'}`}>
          {formatDate(msg.timestamp)}
        </p>
      </div>
    </div>
  );
}

function FileUploader({ files, onSelectFiles, onMove, onRemove, disabled }) {
  const inputRef = useRef(null);

  return (
    <div className="space-y-4">
      <div
        className="rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 p-6 text-center"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (disabled) return;
          onSelectFiles(Array.from(event.dataTransfer.files || []));
        }}
      >
        <Upload className="mx-auto h-8 w-8 text-slate-400" />
        <p className="mt-3 text-sm font-medium text-slate-700">영상(.mp4)과 음성(.m4a/.mp3/.wav)을 업로드하세요</p>
        <p className="mt-1 text-xs text-slate-500">드래그앤드롭 또는 파일 선택</p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          className="mt-4 inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          <Upload className="h-4 w-4" />
          파일 선택
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => onSelectFiles(Array.from(event.target.files || []))}
        />
      </div>

      <div className="space-y-2">
        {files.map((file, index) => (
          <div key={file.localId || file.id} className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-slate-900">{file.original_name || file.name}</p>
              <p className="mt-1 text-xs text-slate-500">
                {(file.file_type || (String(file.name || '').endsWith('.mp4') ? 'video' : 'audio'))}
                {' · '}
                {file.file_size_mb ? `${file.file_size_mb}MB` : `${(Number(file.size || 0) / 1024 / 1024).toFixed(2)}MB`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => onMove(file, -1)} disabled={disabled || index === 0} className="rounded-lg border border-slate-200 p-2 text-slate-600 disabled:opacity-40">
                <ArrowUp className="h-4 w-4" />
              </button>
              <button type="button" onClick={() => onMove(file, 1)} disabled={disabled || index === files.length - 1} className="rounded-lg border border-slate-200 p-2 text-slate-600 disabled:opacity-40">
                <ArrowDown className="h-4 w-4" />
              </button>
              <button type="button" onClick={() => onRemove(file)} disabled={disabled} className="rounded-lg border border-rose-200 px-3 py-2 text-xs font-medium text-rose-600 disabled:opacity-40">
                삭제
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProgressTracker({ session, edits }) {
  const stages = ['processing', 'preprocessing_done', 'stt_done', 'correction_done', 'preview_ready', 'completed'];

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">세션 상태</p>
            <p className="mt-1 text-sm text-slate-600">{session.status}</p>
          </div>
          <div className="text-right text-xs text-slate-500">
            <p>예상 시간: {formatMs(session.estimated_time_ms)}</p>
            <p>파일 수: {session.file_count || 0}</p>
          </div>
        </div>
      </div>

      {edits.map((edit) => (
        <div key={edit.id} className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-900">세트 #{edit.pair_index || edit.id}</p>
              <p className="mt-1 text-xs text-slate-500">{edit.title || '자동 편집 세트'}</p>
            </div>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">{edit.status}</span>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            {stages.map((stage) => {
              const active = stages.indexOf(edit.status) >= stages.indexOf(stage) || edit.status === stage;
              return (
                <div key={stage} className={`rounded-xl px-3 py-2 text-xs font-medium ${active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-50 text-slate-400'}`}>
                  {stage}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function PreviewCard({ edit, onConfirm, onReject, busy }) {
  const videoRef = useRef(null);
  const [feedback, setFeedback] = useState('');
  const [currentTime, setCurrentTime] = useState('00:00:00');
  const [media, setMedia] = useState({ videoUrl: '', subtitleUrl: '' });
  const [mediaError, setMediaError] = useState('');

  useEffect(() => {
    let mounted = true;
    let videoUrl = '';
    let subtitleUrl = '';

    const loadMedia = async () => {
      try {
        const [videoBlob, subtitleBlob] = await Promise.all([
          fetchProtectedBlob(`/api/video/edits/${edit.id}/preview`),
          fetchProtectedBlob(`/api/video/edits/${edit.id}/subtitle`),
        ]);
        videoUrl = URL.createObjectURL(videoBlob);
        subtitleUrl = URL.createObjectURL(subtitleBlob);
        if (!mounted) return;
        setMedia({ videoUrl, subtitleUrl });
      } catch (error) {
        if (!mounted) return;
        setMediaError(error.message);
      }
    };

    loadMedia();
    return () => {
      mounted = false;
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      if (subtitleUrl) URL.revokeObjectURL(subtitleUrl);
    };
  }, [edit.id]);

  const applyCurrentTime = () => {
    const seconds = videoRef.current?.currentTime || 0;
    setFeedback((prev) => `${formatTimestamp(seconds)} — ${prev || ''}`.trim());
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-base font-semibold text-slate-900">세트 #{edit.pair_index || edit.id}</p>
          <p className="mt-1 text-xs text-slate-500">상태: {edit.status} · 품질 점수: {edit.quality_score ?? '미측정'}</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${edit.confirm_status === 'confirmed' ? 'bg-emerald-50 text-emerald-700' : edit.confirm_status === 'rejected' ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700'}`}>
          {edit.confirm_status || 'pending'}
        </span>
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl bg-black">
        <video
          ref={videoRef}
          controls
          className="aspect-video w-full"
          onTimeUpdate={() => setCurrentTime(formatTimestamp(videoRef.current?.currentTime || 0))}
        >
          {media.videoUrl ? <source src={media.videoUrl} type="video/mp4" /> : null}
          {media.subtitleUrl ? <track src={media.subtitleUrl} kind="subtitles" srcLang="ko" default /> : null}
        </video>
      </div>
      {mediaError ? (
        <p className="mt-2 text-xs text-rose-600">{mediaError}</p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span>현재 시간: {currentTime}</span>
        <button type="button" onClick={applyCurrentTime} className="rounded-full border border-slate-200 px-3 py-1 text-xs font-medium text-slate-700">
          현재 시간 삽입
        </button>
      </div>

      <textarea
        value={feedback}
        onChange={(event) => setFeedback(event.target.value)}
        className="mt-4 min-h-[100px] w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
        placeholder={"예: 00:02:30 — 여기 잘라줘\n예: 00:05:00 — 페이드 추가"}
      />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onConfirm(edit)}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          <CheckCircle2 className="h-4 w-4" />
          확인(OK)
        </button>
        <button
          type="button"
          onClick={() => onReject(edit, feedback)}
          disabled={busy || !feedback.trim()}
          className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          <RefreshCcw className="h-4 w-4" />
          재편집 요청
        </button>
        {edit.output_path ? (
          <button
            type="button"
            onClick={() => downloadProtectedFile(`/api/video/edits/${edit.id}/download`, `video-edit-${edit.id}.mp4`)}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700"
          >
            <Download className="h-4 w-4" />
            최종본 다운로드
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default function VideoPage() {
  const searchParams = useSearchParams();
  const [phase, setPhase] = useState(PHASES.idle);
  const [messages, setMessages] = useState([]);
  const [session, setSession] = useState(null);
  const [files, setFiles] = useState([]);
  const [edits, setEdits] = useState([]);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const messageBottomRef = useRef(null);

  useEffect(() => {
    addMessage(setMessages, {
      type: 'system',
      content: '안녕하세요! 영상 편집을 시작합니다. 영상 파일(.mp4)과 음성 파일(.m4a)을 업로드해주세요.',
    });
  }, []);

  useEffect(() => {
    const sessionId = searchParams.get('session');
    if (!sessionId) return;
    let alive = true;
    api.get(`/video/sessions/${sessionId}`)
      .then((data) => {
        if (!alive) return;
        const nextSession = data.session;
        const nextFiles = data.files || [];
        const nextEdits = data.edits || [];
        setSession(nextSession);
        setFiles(nextFiles);
        setEdits(nextEdits);

        if (nextSession.status === 'done') setPhase(PHASES.done);
        else if (nextSession.status === 'rendering') setPhase(PHASES.rendering);
        else if (nextSession.status === 'preview_ready') setPhase(PHASES.preview_ready);
        else if (nextSession.status === 'processing') setPhase(PHASES.processing);
        else if (nextSession.status === 'uploaded' || nextSession.status === 'uploading') setPhase(PHASES.uploaded);
        else if (nextSession.status === 'failed') setPhase(PHASES.failed);

        addMessage(setMessages, {
          type: 'system',
          content: `기존 편집 세션 #${nextSession.id}를 불러왔습니다.`,
        });
      })
      .catch((loadError) => {
        if (!alive) return;
        setError(loadError.message);
      });
    return () => {
      alive = false;
    };
  }, [searchParams]);

  useEffect(() => {
    messageBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (!session?.id || ![PHASES.processing, PHASES.preview_ready, PHASES.confirming, PHASES.rendering].includes(phase)) {
      return undefined;
    }

    const poll = async () => {
      try {
        const data = await api.get(`/video/sessions/${session.id}/status`);
        setSession(data.session);
        setEdits(data.edits || []);

        if (data.session.status === 'preview_ready') {
          setPhase(PHASES.preview_ready);
        } else if (data.session.status === 'rendering') {
          setPhase(PHASES.rendering);
        } else if (data.session.status === 'done') {
          setPhase(PHASES.done);
        } else if (data.session.status === 'failed') {
          setPhase(PHASES.failed);
        }
      } catch (pollError) {
        setError(pollError.message);
      }
    };

    poll();
    const timer = setInterval(poll, 5000);
    return () => clearInterval(timer);
  }, [phase, session?.id]);

  const phaseLabel = useMemo(() => {
    switch (phase) {
      case PHASES.uploading: return '파일 업로드';
      case PHASES.uploaded: return '편집 준비';
      case PHASES.processing: return 'AI 편집 진행';
      case PHASES.preview_ready: return '프리뷰 확인';
      case PHASES.confirming: return '컨펌 진행';
      case PHASES.rendering: return '최종 렌더링';
      case PHASES.done: return '완료';
      case PHASES.failed: return '실패';
      default: return '대기';
    }
  }, [phase]);

  const startSession = async () => {
    setLoading(true);
    setError('');
    try {
      const created = await api.post('/video/sessions', { title: '새 영상 편집' });
      setSession(created);
      setPhase(PHASES.uploading);
      addMessage(setMessages, {
        type: 'system',
        content: '새 편집 세션을 만들었습니다. 파일을 업로드해주세요.',
      });
    } catch (sessionError) {
      setError(sessionError.message);
    } finally {
      setLoading(false);
    }
  };

  const uploadFiles = async (selectedFiles) => {
    if (!session?.id || !selectedFiles?.length) return;
    setLoading(true);
    setError('');
    try {
      const formData = new FormData();
      selectedFiles.forEach((file) => formData.append('files', file));
      const token = getToken();
      const response = await fetch(`/api/video/sessions/${session.id}/upload`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || '파일 업로드에 실패했습니다.');
      }
      const detail = await api.get(`/video/sessions/${session.id}`);
      setSession(detail.session);
      setFiles(detail.files || []);
      setPhase(PHASES.uploaded);
      addMessage(setMessages, {
        type: 'user',
        content: `${selectedFiles.length}개 파일을 업로드했습니다.`,
      });
      addMessage(setMessages, {
        type: 'system',
        content: '편집에 참고할 사항이 있으면 알려주세요. 준비되면 편집을 시작합니다.',
      });
    } catch (uploadError) {
      setError(uploadError.message);
    } finally {
      setLoading(false);
    }
  };

  const reorderFiles = async (targetFile, direction) => {
    const currentIndex = files.findIndex((item) => item.id === targetFile.id);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= files.length) return;
    const reordered = [...files];
    [reordered[currentIndex], reordered[nextIndex]] = [reordered[nextIndex], reordered[currentIndex]];
    const payload = reordered.map((item, index) => ({
      id: item.id,
      sort_order: index + 1,
    }));

    setFiles(reordered.map((item, index) => ({ ...item, sort_order: index + 1 })));
    try {
      await api.put(`/video/sessions/${session.id}/reorder`, { files: payload });
    } catch (reorderError) {
      setError(reorderError.message);
    }
  };

  const removeFile = async (file) => {
    try {
      await api.delete(`/video/sessions/${session.id}/files/${file.id}`);
      const detail = await api.get(`/video/sessions/${session.id}`);
      setFiles(detail.files || []);
      setSession(detail.session);
    } catch (removeError) {
      setError(removeError.message);
    }
  };

  const startProcessing = async () => {
    if (!session?.id) return;
    setLoading(true);
    setError('');
    try {
      if (notes.trim()) {
        await api.put(`/video/sessions/${session.id}/notes`, { edit_notes: notes.trim() });
      }
      await api.post(`/video/sessions/${session.id}/start`, {});
      setPhase(PHASES.processing);
      addMessage(setMessages, {
        type: 'user',
        content: notes.trim() || '편집 시작',
      });
      addMessage(setMessages, {
        type: 'system',
        content: 'AI가 자동 편집을 시작했습니다. 세트별 진행 상태를 추적합니다.',
      });
    } catch (startError) {
      setError(startError.message);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async (edit) => {
    try {
      await api.post(`/video/edits/${edit.id}/confirm`, {});
      const status = await api.get(`/video/sessions/${session.id}/status`);
      setSession(status.session);
      setEdits(status.edits || []);
      setPhase(status.session.status === 'rendering' ? PHASES.rendering : PHASES.confirming);
    } catch (confirmError) {
      setError(confirmError.message);
    }
  };

  const handleReject = async (edit, reason) => {
    try {
      await api.post(`/video/edits/${edit.id}/reject`, { reason });
      const status = await api.get(`/video/sessions/${session.id}/status`);
      setSession(status.session);
      setEdits(status.edits || []);
      setPhase(PHASES.confirming);
    } catch (rejectError) {
      setError(rejectError.message);
    }
  };

  return (
    <div className="flex min-h-[calc(100vh-8rem)] flex-col rounded-3xl border border-slate-200 bg-slate-50 shadow-sm">
      <div className="border-b border-slate-200 bg-white px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
              <Sparkles className="h-3.5 w-3.5" />
              AI 영상 편집 워크스페이스
            </p>
            <h1 className="mt-2 text-2xl font-bold text-slate-900">영상 편집</h1>
            <p className="mt-1 text-sm text-slate-500">업로드 → AI 편집 → 프리뷰 확인 → 렌더링 다운로드</p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/video/history" className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700">
              <Clock3 className="h-4 w-4" />
              편집 이력
            </Link>
            {session?.id && phase === PHASES.done ? (
              <button
                type="button"
                onClick={() => downloadProtectedFile(`/api/video/sessions/${session.id}/download-all`, `video-session-${session.id}.zip`)}
                className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white"
              >
                <Download className="h-4 w-4" />
                전체 ZIP
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="space-y-4">
          {messages.map((msg) => (
            <ChatBubble key={msg.id} msg={msg} />
          ))}
          {error ? (
            <ChatBubble
              msg={{
                id: 'error',
                type: 'system',
                timestamp: new Date().toISOString(),
                content: `오류: ${error}`,
              }}
            />
          ) : null}

          {[PHASES.processing, PHASES.preview_ready, PHASES.confirming, PHASES.rendering, PHASES.done].includes(phase) && session ? (
            <ChatBubble
              msg={{
                id: 'status',
                type: 'system',
                timestamp: new Date().toISOString(),
                content: `현재 단계: ${phaseLabel}`,
                component: phase === PHASES.preview_ready || phase === PHASES.confirming || phase === PHASES.done
                  ? (
                    <div className="space-y-4">
                      {edits.map((edit) => (
                        <PreviewCard
                          key={edit.id}
                          edit={edit}
                          busy={loading}
                          onConfirm={handleConfirm}
                          onReject={handleReject}
                        />
                      ))}
                    </div>
                  )
                  : <ProgressTracker session={session} edits={edits} />,
              }}
            />
          ) : null}
          <div ref={messageBottomRef} />
        </div>
      </div>

      <div className="border-t border-slate-200 bg-white p-4 sm:p-5">
        {phase === PHASES.idle && (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-slate-900">영상 편집을 시작할 준비가 되었습니다.</p>
              <p className="mt-1 text-sm text-slate-500">새 세션을 만들고 파일 업로드부터 진행합니다.</p>
            </div>
            <button onClick={startSession} disabled={loading} className="inline-flex items-center justify-center gap-2 rounded-2xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Video className="h-4 w-4" />}
              새 편집 시작
            </button>
          </div>
        )}

        {[PHASES.uploading, PHASES.uploaded].includes(phase) && session && (
          <div className="space-y-4">
            <FileUploader
              files={files}
              onSelectFiles={uploadFiles}
              onMove={reorderFiles}
              onRemove={removeFile}
              disabled={loading}
            />
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <label className="text-sm font-semibold text-slate-900">편집 의도</label>
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="예: 무음 구간은 과감하게 잘라주고, 핵심 개념은 텍스트 오버레이를 넣어주세요."
                className="mt-3 min-h-[100px] w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button onClick={startProcessing} disabled={loading || files.length < 2} className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
                  편집 시작
                </button>
                <p className="text-xs text-slate-500">영상과 음성 파일을 각각 업로드한 뒤 순서를 맞춰주세요.</p>
              </div>
            </div>
          </div>
        )}

        {[PHASES.processing, PHASES.rendering].includes(phase) && (
          <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
            <Loader2 className="h-5 w-5 animate-spin text-indigo-600" />
            <div>
              <p className="font-semibold">{phase === PHASES.processing ? 'AI 자동 편집 진행 중' : '최종 렌더링 진행 중'}</p>
              <p className="mt-1 text-xs text-slate-500">5초마다 상태를 새로고침합니다.</p>
            </div>
          </div>
        )}

        {phase === PHASES.done && session && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-6 w-6 text-emerald-600" />
              <div>
                <p className="text-sm font-semibold text-emerald-800">렌더링이 완료되었습니다.</p>
                <p className="mt-1 text-xs text-emerald-700">개별 다운로드 또는 전체 ZIP 다운로드가 가능합니다.</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => downloadProtectedFile(`/api/video/sessions/${session.id}/download-all`, `video-session-${session.id}.zip`)}
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-700 px-4 py-2 text-sm font-medium text-white"
            >
              <Download className="h-4 w-4" />
              전체 ZIP 다운로드
            </button>
          </div>
        )}

        {phase === PHASES.failed && (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            편집 파이프라인이 실패했습니다. 오류 메시지를 확인한 뒤 다시 시도해주세요.
          </div>
        )}
      </div>
    </div>
  );
}
