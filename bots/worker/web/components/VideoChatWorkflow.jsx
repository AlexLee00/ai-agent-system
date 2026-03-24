'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';

import { api } from '@/lib/api';
import { getToken } from '@/lib/auth-context';
import ChatCard from './ChatCard';
import ChatMessage from './ChatMessage';

const ACTIVE_VIDEO_SESSION_KEY = 'worker_video_active_session_id';

function normalizeFileName(name) {
  const raw = String(name || '');
  if (!raw || /[가-힣]/.test(raw)) return raw;
  try {
    const decoded = decodeURIComponent(escape(raw));
    return /[가-힣]/.test(decoded) ? decoded : raw;
  } catch {
    return raw;
  }
}

function writeActiveSessionId(sessionId) {
  if (typeof window === 'undefined') return;
  try {
    if (!sessionId) {
      window.localStorage.removeItem(ACTIVE_VIDEO_SESSION_KEY);
      return;
    }
    window.localStorage.setItem(ACTIVE_VIDEO_SESSION_KEY, String(sessionId));
  } catch {
    // 무시
  }
}

async function uploadFiles(sessionId, files, requestedFileType = '') {
  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file);
  }
  if (requestedFileType) formData.append('requestedFileType', requestedFileType);

  const token = getToken();
  const response = await fetch(`/api/video/sessions/${sessionId}/upload`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || '파일 업로드에 실패했습니다.');
  }
  return payload;
}

function toDraftFiles(files) {
  return (files || []).map((file) => ({
    name: normalizeFileName(file.name || file.originalname),
    size: Number(file.size || 0),
    type: file.type || file.mimetype || '',
  }));
}

function buildChatPhase(session, files) {
  if (!session) return 'greeting';
  const rawFiles = files.filter((file) => file.file_type === 'video');
  const audioFiles = files.filter((file) => file.file_type === 'audio');
  if (!rawFiles.length || !audioFiles.length) return 'upload';
  if (!session.intro_mode) return 'intro';
  if (!session.outro_mode) return 'outro';
  if (!session.edit_notes) return 'edit_intent';
  return 'summary';
}

function toAssetPatch(payload = {}) {
  return {
    mode: payload.mode || 'none',
    prompt: String(payload.prompt || '').trim(),
    durationSec: payload.durationSec || '',
  };
}

export default function VideoChatWorkflow({
  sessionId = null,
  resetToken = 0,
  onEditStart,
  onSessionChange,
}) {
  const [session, setSession] = useState(null);
  const [files, setFiles] = useState([]);
  const [edits, setEdits] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [chatPhase, setChatPhase] = useState('greeting');
  const bootstrapRef = useRef(false);

  async function loadSession(targetSessionId) {
    if (!targetSessionId) {
      setSession(null);
      setFiles([]);
      setEdits([]);
      setChatPhase('greeting');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const data = await api.get(`/video/sessions/${targetSessionId}`);
      setSession(data.session || null);
      setFiles(data.files || []);
      setEdits(data.edits || []);
      setChatPhase(buildChatPhase(data.session || null, data.files || []));
      writeActiveSessionId(data.session?.id || '');
      onSessionChange?.(data.session || null);
    } catch (fetchError) {
      setError(fetchError.message || '세션을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  async function createSession() {
    setLoading(true);
    setError('');
    try {
      const created = await api.post('/video/sessions', {});
      await loadSession(created.id);
    } catch (createError) {
      setError(createError.message || '새 편집 세션 생성에 실패했습니다.');
      setLoading(false);
    }
  }

  useEffect(() => {
    bootstrapRef.current = false;
  }, [resetToken]);

  useEffect(() => {
    if (sessionId) {
      loadSession(sessionId);
      bootstrapRef.current = true;
      return;
    }
    if (bootstrapRef.current) return;
    bootstrapRef.current = true;
    loadSession(null);
  }, [sessionId, resetToken]);

  const rawFiles = useMemo(() => files.filter((file) => file.file_type === 'video'), [files]);
  const audioFiles = useMemo(() => files.filter((file) => file.file_type === 'audio'), [files]);
  const introLabel = useMemo(() => {
    if (!session?.intro_mode || session.intro_mode === 'none') return '없음';
    return session.intro_mode === 'file' ? '파일' : '프롬프트';
  }, [session]);
  const outroLabel = useMemo(() => {
    if (!session?.outro_mode || session.outro_mode === 'none') return '없음';
    return session.outro_mode === 'file' ? '파일' : '프롬프트';
  }, [session]);

  async function handleMainUpload(selectedFiles) {
    setBusy('upload');
    setError('');
    try {
      let activeSessionId = session?.id || null;
      if (!activeSessionId) {
        const created = await api.post('/video/sessions', {});
        activeSessionId = created.id;
      }
      await uploadFiles(activeSessionId, selectedFiles);
      await loadSession(activeSessionId);
      setChatPhase('intro');
    } catch (uploadError) {
      setError(uploadError.message || '파일 업로드에 실패했습니다.');
    } finally {
      setBusy('');
    }
  }

  async function handleAssetSubmit(kind, payload) {
    if (!session?.id) return;
    setBusy(kind);
    setError('');
    try {
      if (payload.mode === 'file' && payload.file) {
        await uploadFiles(session.id, [payload.file], kind);
      }
      await api.put(`/video/sessions/${session.id}/intro-outro`, {
        intro: kind === 'intro' ? toAssetPatch(payload) : {
          mode: session?.intro_mode || 'none',
          prompt: session?.intro_prompt || '',
          durationSec: session?.intro_duration_sec || '',
        },
        outro: kind === 'outro' ? toAssetPatch(payload) : {
          mode: session?.outro_mode || 'none',
          prompt: session?.outro_prompt || '',
          durationSec: session?.outro_duration_sec || '',
        },
      });
      await loadSession(session.id);
      setChatPhase(kind === 'intro' ? 'outro' : 'edit_intent');
    } catch (nextError) {
      setError(nextError.message || `${kind} 설정 반영에 실패했습니다.`);
    } finally {
      setBusy('');
    }
  }

  async function handleIntentSubmit(value) {
    if (!session?.id) return;
    setBusy('intent');
    setError('');
    try {
      await api.put(`/video/sessions/${session.id}/notes`, {
        edit_notes: value,
      });
      await loadSession(session.id);
      setChatPhase('summary');
    } catch (nextError) {
      setError(nextError.message || '편집 의도 저장에 실패했습니다.');
    } finally {
      setBusy('');
    }
  }

  async function handleStartEdit() {
    if (!session?.id) return;
    setBusy('start');
    setError('');
    try {
      const result = await api.post(`/video/sessions/${session.id}/start`, {});
      const directEditId = result.dispatches?.find((item) => item.editId)?.editId;
      if (directEditId) {
        onEditStart?.(directEditId);
        return;
      }
      const status = await api.get(`/video/sessions/${session.id}/status`);
      const fallbackEditId = status.edits?.[0]?.id;
      if (!fallbackEditId) {
        throw new Error('편집 세트가 아직 생성되지 않았습니다. 잠시 후 다시 시도해주세요.');
      }
      onEditStart?.(fallbackEditId);
    } catch (nextError) {
      setError(nextError.message || '편집 시작에 실패했습니다.');
    } finally {
      setBusy('');
    }
  }

  const messages = useMemo(() => {
    const list = [];
    const now = new Date().toISOString();
    list.push({
      id: 'greeting',
      role: 'ai',
      content: '새 편집을 시작합니다. 영상을 업로드해주세요.',
      timestamp: now,
      card: 'upload',
    });

    if (rawFiles.length && audioFiles.length) {
      list.push({
        id: 'upload-done',
        role: 'ai',
        content: `영상 ${rawFiles.length}개, 음성 ${audioFiles.length}개 확인했습니다.`,
        timestamp: now,
      });
      list.push({
        id: 'intro',
        role: 'ai',
        content: '인트로 파일이 있나요?',
        timestamp: now,
        card: 'intro',
      });
    }

    if (session?.intro_mode) {
      list.push({
        id: 'intro-done',
        role: 'system',
        content: `인트로 설정을 반영했습니다. (${introLabel})`,
        timestamp: now,
      });
      list.push({
        id: 'outro',
        role: 'ai',
        content: '아웃트로 파일이 있나요?',
        timestamp: now,
        card: 'outro',
      });
    }

    if (session?.outro_mode) {
      list.push({
        id: 'outro-done',
        role: 'system',
        content: `인트로 ${introLabel}, 아웃트로 ${outroLabel} 확인했습니다.`,
        timestamp: now,
      });
      list.push({
        id: 'intent',
        role: 'ai',
        content: '편집의도를 작성해주세요.',
        timestamp: now,
        card: 'edit_intent',
      });
    }

    if (session?.edit_notes) {
      list.push({
        id: 'intent-user',
        role: 'user',
        content: session.edit_notes,
        timestamp: now,
      });
      list.push({
        id: 'summary',
        role: 'ai',
        content: '설정 요약입니다. 확인 후 편집을 시작할 수 있습니다.',
        timestamp: now,
        card: 'summary',
      });
    }

    return list;
  }, [audioFiles.length, introLabel, outroLabel, rawFiles.length, session]);

  const summary = useMemo(() => ({
    videoCount: rawFiles.length,
    audioCount: audioFiles.length,
    introLabel,
    outroLabel,
    editNotes: session?.edit_notes || '',
  }), [audioFiles.length, introLabel, outroLabel, rawFiles.length, session]);

  const draftFiles = useMemo(() => {
    return toDraftFiles([
      ...rawFiles.map((file) => ({ name: file.original_name, size: Number(file.file_size_bytes || 0), type: 'video/mp4' })),
      ...audioFiles.map((file) => ({ name: file.original_name, size: Number(file.file_size_bytes || 0), type: 'audio/mp4' })),
    ]);
  }, [audioFiles, rawFiles]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-200 px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-100 text-violet-700">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-500">AI Chat Workflow</p>
            <h2 className="mt-1 text-lg font-semibold text-slate-900">대화형 영상 설정</h2>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="space-y-4">
          {messages.map((message) => (
            <ChatMessage
              key={message.id}
              role={message.role}
              content={message.content}
              timestamp={message.timestamp}
            >
              {message.card === 'upload' && chatPhase === 'upload' ? (
                <ChatCard
                  type="upload"
                  files={draftFiles}
                  disabled={busy === 'upload' || loading}
                  onSelectFiles={handleMainUpload}
                />
              ) : null}

              {message.card === 'intro' && chatPhase === 'intro' ? (
                <ChatCard
                  type="intro"
                  value={{
                    mode: session?.intro_mode || 'none',
                    prompt: session?.intro_prompt || '',
                    durationSec: session?.intro_duration_sec || '',
                  }}
                  disabled={busy === 'intro'}
                  onSubmit={(payload) => handleAssetSubmit('intro', payload)}
                />
              ) : null}

              {message.card === 'outro' && chatPhase === 'outro' ? (
                <ChatCard
                  type="outro"
                  value={{
                    mode: session?.outro_mode || 'none',
                    prompt: session?.outro_prompt || '',
                    durationSec: session?.outro_duration_sec || '',
                  }}
                  disabled={busy === 'outro'}
                  onSubmit={(payload) => handleAssetSubmit('outro', payload)}
                />
              ) : null}

              {message.card === 'edit_intent' && chatPhase === 'edit_intent' ? (
                <ChatCard
                  type="edit_intent"
                  value={session?.edit_notes || ''}
                  disabled={busy === 'intent'}
                  onSubmit={handleIntentSubmit}
                />
              ) : null}

              {message.card === 'summary' && chatPhase === 'summary' ? (
                <ChatCard
                  type="summary"
                  summary={summary}
                  disabled={busy === 'start'}
                  onStart={handleStartEdit}
                />
              ) : null}
            </ChatMessage>
          ))}
          {busy ? (
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              처리 중...
            </div>
          ) : null}
          {error ? (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}
            </div>
          ) : null}
          {edits.length ? (
            <div className="rounded-3xl border border-slate-200 bg-slate-50 px-4 py-4">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">최근 편집 세트</p>
              <div className="mt-3 space-y-2">
                {edits.slice(0, 3).map((edit) => (
                  <div key={edit.id} className="rounded-2xl bg-white px-3 py-3 text-sm text-slate-700 shadow-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-slate-900">{edit.title || `편집 #${edit.id}`}</span>
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600">{edit.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
