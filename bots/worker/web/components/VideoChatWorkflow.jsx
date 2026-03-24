'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Loader2, Sparkles } from 'lucide-react';

import { api } from '@/lib/api';
import { getToken } from '@/lib/auth-context';
import ChatCard from './ChatCard';
import ChatMessage from './ChatMessage';

const ACTIVE_VIDEO_SESSION_KEY = 'worker_video_active_session_id';
const WORKFLOW_PHASE_PREFIX = 'worker_video_workflow_phase:';
const WORKFLOW_STEPS = ['upload', 'intro', 'outro', 'edit_intent', 'summary'];

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

function readActiveSessionId() {
  if (typeof window === 'undefined') return '';
  try {
    return String(window.localStorage.getItem(ACTIVE_VIDEO_SESSION_KEY) || '').trim();
  } catch {
    return '';
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

function readWorkflowPhase(sessionId) {
  if (typeof window === 'undefined' || !sessionId) return '';
  try {
    return String(window.localStorage.getItem(`${WORKFLOW_PHASE_PREFIX}${sessionId}`) || '').trim();
  } catch {
    return '';
  }
}

function writeWorkflowPhase(sessionId, phase) {
  if (typeof window === 'undefined' || !sessionId) return;
  try {
    if (!phase) {
      window.localStorage.removeItem(`${WORKFLOW_PHASE_PREFIX}${sessionId}`);
      return;
    }
    window.localStorage.setItem(`${WORKFLOW_PHASE_PREFIX}${sessionId}`, phase);
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

function buildComputedPhase(session, files) {
  if (!session) return 'upload';
  const rawFiles = files.filter((file) => file.file_type === 'video');
  const audioFiles = files.filter((file) => file.file_type === 'audio');
  if (!rawFiles.length || !audioFiles.length) return 'upload';
  if (!session.intro_mode) return 'intro';
  if (!session.outro_mode) return 'outro';
  if (!session.edit_notes) return 'edit_intent';
  return 'summary';
}

function resolveWorkflowPhase(session, files) {
  const computed = buildComputedPhase(session, files);
  if (!session?.id) return computed;
  const stored = readWorkflowPhase(session.id);
  if (!stored || !WORKFLOW_STEPS.includes(stored)) return computed;
  const computedIndex = WORKFLOW_STEPS.indexOf(computed);
  const storedIndex = WORKFLOW_STEPS.indexOf(stored);
  return storedIndex <= computedIndex ? stored : computed;
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
  const [chatPhase, setChatPhase] = useState('upload');
  const [uploaderTick, setUploaderTick] = useState(0);
  const bootstrapRef = useRef(false);
  const scrollRef = useRef(null);

  async function loadSession(targetSessionId) {
    if (!targetSessionId) {
      setSession(null);
      setFiles([]);
      setEdits([]);
      setChatPhase('upload');
      return;
    }

    setLoading(true);
    setError('');
    try {
      const data = await api.get(`/video/sessions/${targetSessionId}`);
      setSession(data.session || null);
      setFiles(data.files || []);
      setEdits(data.edits || []);
      setChatPhase(resolveWorkflowPhase(data.session || null, data.files || []));
      writeActiveSessionId(data.session?.id || '');
      onSessionChange?.(data.session || null);
    } catch (fetchError) {
      setError(fetchError.message || '세션을 불러오지 못했습니다.');
    } finally {
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
    const rememberedSessionId = readActiveSessionId();
    if (rememberedSessionId) {
      loadSession(rememberedSessionId);
      return;
    }
    loadSession(null);
  }, [sessionId, resetToken]);

  useEffect(() => {
    if (session?.id) {
      writeWorkflowPhase(session.id, chatPhase);
    }
  }, [chatPhase, session?.id]);

  const rawFiles = useMemo(() => files.filter((file) => file.file_type === 'video'), [files]);
  const audioFiles = useMemo(() => files.filter((file) => file.file_type === 'audio'), [files]);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [chatPhase, error, busy, rawFiles.length, audioFiles.length, session?.id, session?.intro_mode, session?.outro_mode, session?.edit_notes]);

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
        writeActiveSessionId(activeSessionId);
      }
      await uploadFiles(activeSessionId, selectedFiles);
      await loadSession(activeSessionId);
    } catch (uploadError) {
      setError(uploadError.message || '파일 업로드에 실패했습니다.');
    } finally {
      setBusy('');
      setUploaderTick((prev) => prev + 1);
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

  const draftFiles = useMemo(() => (
    toDraftFiles([
      ...rawFiles.map((file) => ({ name: file.original_name, size: Number(file.file_size_bytes || 0), type: 'video/mp4' })),
      ...audioFiles.map((file) => ({ name: file.original_name, size: Number(file.file_size_bytes || 0), type: 'audio/mp4' })),
    ])
  ), [audioFiles, rawFiles]);

  const summary = useMemo(() => ({
    videoCount: rawFiles.length,
    audioCount: audioFiles.length,
    introLabel,
    outroLabel,
    editNotes: session?.edit_notes || '',
  }), [audioFiles.length, introLabel, outroLabel, rawFiles.length, session]);

  const canContinueUpload = rawFiles.length > 0 && audioFiles.length > 0;

  const messages = useMemo(() => {
    const now = new Date().toISOString();
    const items = [];
    items.push({
      id: 'start',
      role: 'ai',
      content: session?.id
        ? '기존 작업을 이어서 불러왔습니다.'
        : '새 편집을 시작합니다. 먼저 원본 영상과 나레이션 파일을 올려주세요.',
      timestamp: now,
    });

    if (rawFiles.length > 0 || audioFiles.length > 0) {
      items.push({
        id: 'upload-summary',
        role: 'system',
        content: `현재 업로드 상태: 영상 ${rawFiles.length}개, 음성 ${audioFiles.length}개`,
        timestamp: now,
      });
    }

    if (session?.intro_mode) {
      items.push({
        id: 'intro-done',
        role: 'system',
        content: `인트로 설정을 반영했습니다. (${introLabel})`,
        timestamp: now,
      });
    }

    if (session?.outro_mode) {
      items.push({
        id: 'outro-done',
        role: 'system',
        content: `인트로 ${introLabel}, 아웃트로 ${outroLabel} 확인했습니다.`,
        timestamp: now,
      });
    }

    if (session?.edit_notes) {
      items.push({
        id: 'intent-user',
        role: 'user',
        content: session.edit_notes,
        timestamp: now,
      });
    }

    const promptMap = {
      upload: canContinueUpload
        ? '파일을 더 추가하시거나 다음 단계로 진행해주세요.'
        : '원본 영상과 나레이션 파일을 올려주세요. 여러 개를 계속 추가할 수 있습니다.',
      intro: '인트로 파일이 있나요?',
      outro: '아웃트로 파일이 있나요?',
      edit_intent: '편집의도를 작성해주세요.',
      summary: '설정 요약입니다. 확인 후 편집을 시작할 수 있습니다.',
    };

    items.push({
      id: 'active-step',
      role: 'ai',
      content: promptMap[chatPhase] || '다음 단계를 진행해주세요.',
      timestamp: now,
    });

    return items;
  }, [audioFiles.length, canContinueUpload, chatPhase, introLabel, outroLabel, rawFiles.length, session?.edit_notes, session?.id, session?.intro_mode, session?.outro_mode]);

  return (
    <div className="flex h-full min-h-0 flex-col">
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

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto w-full max-w-4xl space-y-4">
          {messages.map((message) => (
            <ChatMessage
              key={message.id}
              role={message.role}
              content={message.content}
              timestamp={message.timestamp}
            />
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

      <div className="shrink-0 border-t border-slate-200 bg-white/95 px-5 py-4 backdrop-blur">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
          {!session?.edit_notes ? (
            <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">원본 업로드 창 유지</p>
                  <p className="mt-1 text-sm text-slate-600">여러 파일을 올릴 수 있도록 업로드 창을 계속 유지합니다.</p>
                </div>
                <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600">
                  영상 {rawFiles.length} / 음성 {audioFiles.length}
                </span>
              </div>
              <ChatCard
                key={`uploader-${uploaderTick}-${session?.id || 'new'}`}
                type="upload"
                files={draftFiles}
                disabled={busy === 'upload' || loading}
                onSelectFiles={handleMainUpload}
              />
              {chatPhase === 'upload' ? (
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    disabled={!canContinueUpload || busy === 'upload'}
                    onClick={() => setChatPhase('intro')}
                    className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-300"
                  >
                    다음 단계
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {chatPhase === 'intro' ? (
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

          {chatPhase === 'outro' ? (
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

          {chatPhase === 'edit_intent' ? (
            <ChatCard
              type="edit_intent"
              value={session?.edit_notes || ''}
              disabled={busy === 'intent'}
              onSubmit={handleIntentSubmit}
            />
          ) : null}

          {chatPhase === 'summary' ? (
            <ChatCard
              type="summary"
              summary={summary}
              disabled={busy === 'start'}
              onStart={handleStartEdit}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
