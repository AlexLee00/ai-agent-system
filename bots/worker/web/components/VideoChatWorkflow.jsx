'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Loader2, Sparkles } from 'lucide-react';

import { api } from '@/lib/api';
import { getToken } from '@/lib/auth-context';
import ChatCard from './ChatCard';
import ChatMessage from './ChatMessage';

const ACTIVE_VIDEO_SESSION_KEY = 'worker_video_active_session_id';
const WORKFLOW_PHASE_PREFIX = 'worker_video_workflow_phase:';
const UPLOAD_STATUS_PREFIX = 'worker_video_upload_status:';
const ASSET_STATUS_PREFIX = 'worker_video_asset_status:';
const WORKFLOW_STEPS = ['upload', 'intro', 'outro', 'edit_intent', 'summary'];

function hasHangulText(value) {
  return /[가-힣ㄱ-ㅎㅏ-ㅣ\u1100-\u11ff\u3130-\u318f]/.test(String(value || ''));
}

function normalizeFileName(name) {
  const raw = String(name || '');
  if (!raw || hasHangulText(raw)) return raw.normalize('NFC');
  try {
    const bytes = Uint8Array.from(Array.from(raw), (char) => char.charCodeAt(0) & 0xff);
    const decoded = new TextDecoder('utf-8').decode(bytes).normalize('NFC');
    return hasHangulText(decoded) ? decoded : raw;
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

function readUploadStatusMessage(sessionId) {
  if (typeof window === 'undefined' || !sessionId) return '';
  try {
    return String(window.localStorage.getItem(`${UPLOAD_STATUS_PREFIX}${sessionId}`) || '').trim();
  } catch {
    return '';
  }
}

function writeUploadStatusMessage(sessionId, message) {
  if (typeof window === 'undefined' || !sessionId) return;
  try {
    if (!message) {
      window.localStorage.removeItem(`${UPLOAD_STATUS_PREFIX}${sessionId}`);
      return;
    }
    window.localStorage.setItem(`${UPLOAD_STATUS_PREFIX}${sessionId}`, String(message));
  } catch {
    // 무시
  }
}

function readAssetStatusMessage(sessionId, kind) {
  if (typeof window === 'undefined' || !sessionId || !kind) return '';
  try {
    return String(window.localStorage.getItem(`${ASSET_STATUS_PREFIX}${kind}:${sessionId}`) || '').trim();
  } catch {
    return '';
  }
}

function writeAssetStatusMessage(sessionId, kind, message) {
  if (typeof window === 'undefined' || !sessionId || !kind) return;
  try {
    const key = `${ASSET_STATUS_PREFIX}${kind}:${sessionId}`;
    if (!message) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, String(message));
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
    ...file,
    name: normalizeFileName(file.name || file.originalname),
    size: Number(file.size || 0),
    type: file.type || file.mimetype || '',
  }));
}

function hasAssetSelectionEvidence(session, kind) {
  if (!session) return false;
  const mode = String(kind === 'intro' ? (session.intro_mode || '') : (session.outro_mode || '')).trim();
  const prompt = String(kind === 'intro' ? (session.intro_prompt || '') : (session.outro_prompt || '')).trim();
  return (mode && mode !== 'none') || Boolean(prompt);
}

function buildComputedPhase(session, files) {
  if (!session) return 'upload';
  const rawFiles = files.filter((file) => file.file_type === 'video');
  const audioFiles = files.filter((file) => file.file_type === 'audio');
  if (!rawFiles.length || !audioFiles.length) return 'upload';
  if (!hasAssetSelectionEvidence(session, 'intro')) return 'intro';
  if (!hasAssetSelectionEvidence(session, 'outro')) return 'outro';
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

function countDraftFiles(files, fileType) {
  return files.filter((file) => {
    const type = String(file?.type || '');
    return fileType === 'video' ? type.startsWith('video') : type.startsWith('audio');
  }).length;
}

async function waitForEditorReadySignal(sessionId) {
  const token = getToken();
  const response = await fetch(`/api/video/sessions/${sessionId}/events`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok || !response.body) {
    throw new Error('편집 준비 신호를 구독하지 못했습니다.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (buffer.includes('\n\n')) {
      const splitIndex = buffer.indexOf('\n\n');
      const rawChunk = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + 2);
      const lines = rawChunk.split('\n');
      let payloadText = '';
      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          payloadText += line.slice(5).trim();
        }
      }
      if (currentEvent === 'editor-ready' && payloadText) {
        const payload = JSON.parse(payloadText);
        if (payload?.editId) {
          await reader.cancel().catch(() => {});
          return payload.editId;
        }
      }
      if (currentEvent === 'editor-failed' && payloadText) {
        const payload = JSON.parse(payloadText);
        throw new Error(payload?.error || '편집 파이프라인이 실패했습니다.');
      }
    }
  }

  throw new Error('편집 준비 신호를 기다리는 중 연결이 종료되었습니다.');
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
  const [stagedFiles, setStagedFiles] = useState([]);
  const [pendingUploads, setPendingUploads] = useState([]);
  const [pendingDeleteIds, setPendingDeleteIds] = useState([]);
  const [uploadFeedback, setUploadFeedback] = useState('');
  const [uploadProcessing, setUploadProcessing] = useState(false);
  const [introFeedback, setIntroFeedback] = useState('');
  const [outroFeedback, setOutroFeedback] = useState('');
  const [introProcessing, setIntroProcessing] = useState(false);
  const [outroProcessing, setOutroProcessing] = useState(false);
  const bootstrapRef = useRef(false);
  const scrollRef = useRef(null);
  const suppressAutoScrollRef = useRef(false);

  async function loadSession(targetSessionId) {
    if (!targetSessionId) {
      writeActiveSessionId('');
      setSession(null);
      setFiles([]);
      setEdits([]);
      setChatPhase('upload');
      setUploadFeedback('');
      setIntroFeedback('');
      setOutroFeedback('');
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
      setUploadFeedback(readUploadStatusMessage(data.session?.id || ''));
      setIntroFeedback(readAssetStatusMessage(data.session?.id || '', 'intro'));
      setOutroFeedback(readAssetStatusMessage(data.session?.id || '', 'outro'));
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
    if (resetToken > 0) {
      writeActiveSessionId('');
      loadSession(null);
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

  const rawFiles = useMemo(() => files.filter((file) => file.file_type === 'video'), [files]);
  const audioFiles = useMemo(() => files.filter((file) => file.file_type === 'audio'), [files]);
  const hasPendingUploadChanges = pendingUploads.length > 0 || pendingDeleteIds.length > 0;

  useEffect(() => {
    setStagedFiles(toDraftFiles([
      ...rawFiles.map((file) => ({
        id: file.id,
        name: normalizeFileName(file.original_name),
        size: Number(file.file_size_bytes || (Number(file.file_size_mb || 0) * 1024 * 1024) || 0),
        type: 'video/mp4',
      })),
      ...audioFiles.map((file) => ({
        id: file.id,
        name: normalizeFileName(file.original_name),
        size: Number(file.file_size_bytes || (Number(file.file_size_mb || 0) * 1024 * 1024) || 0),
        type: 'audio/mp4',
      })),
    ]));
    setPendingUploads([]);
    setPendingDeleteIds([]);
  }, [audioFiles, rawFiles]);

  function schedulePhaseChange(nextPhase) {
    suppressAutoScrollRef.current = false;
    window.setTimeout(() => {
      setChatPhase(nextPhase);
    }, 0);
  }

  useEffect(() => {
    if (!session?.id) return;
    const hasUploadedPairs = rawFiles.length > 0 && audioFiles.length > 0;
    if (chatPhase === 'upload' && hasUploadedPairs) return;
    writeWorkflowPhase(session.id, chatPhase);
  }, [audioFiles.length, chatPhase, rawFiles.length, session?.id]);

  useEffect(() => {
    if (!scrollRef.current) return;
    if (suppressAutoScrollRef.current) return;
    if (busy === 'apply-upload-changes' || uploadProcessing || uploadFeedback || introProcessing || outroProcessing) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [audioFiles.length, busy, chatPhase, error, introProcessing, outroProcessing, rawFiles.length, session?.edit_notes, session?.id, session?.intro_mode, session?.outro_mode, uploadFeedback, uploadProcessing]);

  useEffect(() => {
    if (!scrollRef.current || busy !== 'start') return;
    window.requestAnimationFrame(() => {
      if (!scrollRef.current) return;
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
  }, [busy]);

  const introLabel = useMemo(() => {
    if (!session?.intro_mode || session.intro_mode === 'none') return '없음';
    return session.intro_mode === 'file' ? '파일' : '프롬프트';
  }, [session]);

  const outroLabel = useMemo(() => {
    if (!session?.outro_mode || session.outro_mode === 'none') return '없음';
    return session.outro_mode === 'file' ? '파일' : '프롬프트';
  }, [session]);

  function handleMainUpload(selectedFiles) {
    suppressAutoScrollRef.current = true;
    const stampedFiles = selectedFiles.map((file, index) => ({
      tempId: `new:${Date.now()}:${index}:${file.name}`,
      file,
    }));
    setError('');
    setUploadFeedback('');
    writeUploadStatusMessage(session?.id, '');
    setPendingUploads((current) => [...current, ...stampedFiles]);
    setStagedFiles((current) => [
      ...current,
      ...toDraftFiles(stampedFiles.map((item) => ({
        id: item.tempId,
        name: item.file.name,
        size: item.file.size,
        type: item.file.type,
      }))),
    ]);
  }

  async function handleAssetSubmit(kind, payload) {
    if (!session?.id) return;
    const isEditMode = kind === 'intro' ? isIntroEditMode : isOutroEditMode;
    suppressAutoScrollRef.current = isEditMode;
    setBusy(kind);
    setError('');
    if (kind === 'intro') {
      setIntroProcessing(true);
      setIntroFeedback('');
    } else {
      setOutroProcessing(true);
      setOutroFeedback('');
    }
    writeAssetStatusMessage(session.id, kind, '');
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
      const nextLabel = payload.mode === 'file' ? '파일' : payload.mode === 'prompt' ? '프롬프트' : '없음';
      const nextMessage = isEditMode
        ? `${kind === 'intro' ? '인트로' : '아웃트로'} 변경사항을 반영했어요. 현재 설정은 ${nextLabel}이에요.`
        : `${kind === 'intro' ? '인트로' : '아웃트로'}는 ${nextLabel}으로 설정했어요.`;
      writeAssetStatusMessage(session.id, kind, nextMessage);
      if (kind === 'intro') {
        setIntroProcessing(false);
        setIntroFeedback(nextMessage);
      } else {
        setOutroProcessing(false);
        setOutroFeedback(nextMessage);
      }
      if (!isEditMode) {
        suppressAutoScrollRef.current = false;
        setChatPhase(kind === 'intro' ? 'outro' : 'edit_intent');
      }
    } catch (nextError) {
      if (kind === 'intro') {
        setIntroProcessing(false);
      } else {
        setOutroProcessing(false);
      }
      setError(nextError.message || `${kind} 설정 반영에 실패했습니다.`);
    } finally {
      setBusy('');
    }
  }

  async function handleIntentSubmit(value) {
    if (!session?.id) return;
    suppressAutoScrollRef.current = false;
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
    suppressAutoScrollRef.current = false;
    setBusy('start');
    setError('');
    try {
      const result = await api.post(`/video/sessions/${session.id}/start`, {});
      const directEditId = result.dispatches?.find((item) => item.ready && item.editId)?.editId;
      if (directEditId) {
        onEditStart?.(directEditId);
        return;
      }
      let fallbackEditId = null;
      let fallbackError = null;
      try {
        fallbackEditId = await waitForEditorReadySignal(session.id);
      } catch (signalError) {
        fallbackError = signalError;
      }
      if (!fallbackEditId) {
        throw fallbackError || new Error('편집 세트를 준비 중입니다. 잠시 후 다시 시도해주세요.');
      }
      onEditStart?.(fallbackEditId);
    } catch (nextError) {
      setError(nextError.message || '편집 시작에 실패했습니다.');
    } finally {
      setBusy('');
    }
  }

  function handleDeleteFile(file) {
    if (!file?.id) return;
    suppressAutoScrollRef.current = true;
    setError('');
    setUploadFeedback('');
    writeUploadStatusMessage(session?.id, '');
    const fileId = String(file.id);
    if (fileId.startsWith('new:')) {
      setPendingUploads((current) => current.filter((item) => item.tempId !== fileId));
      setStagedFiles((current) => current.filter((item) => String(item.id) !== fileId));
      return;
    }
    setPendingDeleteIds((current) => (current.includes(fileId) ? current : [...current, fileId]));
    setStagedFiles((current) => current.filter((item) => String(item.id) !== fileId));
  }

  async function handleApplyUploadChanges(options = {}) {
    const advancePhase = options.advancePhase || '';
    const initialFlow = Boolean(options.initialFlow);
    if (!hasPendingUploadChanges) return;
    const stagedVideoCount = countDraftFiles(stagedFiles, 'video');
    const stagedAudioCount = countDraftFiles(stagedFiles, 'audio');
    suppressAutoScrollRef.current = true;
    setBusy('apply-upload-changes');
    setError('');
    setUploadProcessing(true);
    setUploadFeedback('');
    writeUploadStatusMessage(session?.id, '');
    try {
      let activeSessionId = session?.id || null;
      if (!activeSessionId) {
        const created = await api.post('/video/sessions', {});
        activeSessionId = created.id;
        writeActiveSessionId(activeSessionId);
      }

      if (pendingUploads.length) {
        await uploadFiles(activeSessionId, pendingUploads.map((item) => item.file));
      }

      for (const fileId of pendingDeleteIds) {
        await api.delete(`/video/sessions/${activeSessionId}/files/${fileId}`);
      }

      await loadSession(activeSessionId);
      setUploadProcessing(false);
      const nextMessage = initialFlow
        ? `업로드를 마쳤어요. 현재 업로드 상태는 영상 ${stagedVideoCount}개, 음성 ${stagedAudioCount}개예요.`
        : `변경사항 업로드를 마쳤어요. 현재 업로드 상태는 영상 ${stagedVideoCount}개, 음성 ${stagedAudioCount}개예요.`;
      writeUploadStatusMessage(activeSessionId, nextMessage);
      window.setTimeout(() => {
        setUploadFeedback(nextMessage);
      }, 160);
      if (advancePhase) {
        suppressAutoScrollRef.current = false;
        schedulePhaseChange(advancePhase);
      }
    } catch (nextError) {
      setUploadProcessing(false);
      setUploadFeedback('');
      setError(nextError.message || '변경사항 업로드에 실패했습니다.');
    } finally {
      setBusy('');
    }
  }

  async function handleContinueUploadStep() {
    if (busy === 'apply-upload-changes') return;
    if (hasPendingUploadChanges) {
      await handleApplyUploadChanges({ advancePhase: 'intro', initialFlow: true });
      return;
    }
    if (!canContinueUpload) return;
    schedulePhaseChange('intro');
  }

  const summary = useMemo(() => ({
    videoCount: rawFiles.length,
    audioCount: audioFiles.length,
    introLabel,
    outroLabel,
    editNotes: session?.edit_notes || '',
  }), [audioFiles.length, introLabel, outroLabel, rawFiles.length, session]);

  const canContinueUpload = rawFiles.length > 0 && audioFiles.length > 0 && !hasPendingUploadChanges;
  const hasDownstreamConfig = hasAssetSelectionEvidence(session, 'intro')
    || hasAssetSelectionEvidence(session, 'outro')
    || Boolean(String(session?.edit_notes || '').trim());
  const isUploadEditMode = hasDownstreamConfig || chatPhase !== 'upload';
  const isIntroEditMode = hasAssetSelectionEvidence(session, 'intro') || chatPhase !== 'intro';
  const isOutroEditMode = hasAssetSelectionEvidence(session, 'outro') || chatPhase !== 'outro';

  const messages = useMemo(() => {
    const now = new Date().toISOString();
    const items = [];
    const currentStepIndex = Math.max(WORKFLOW_STEPS.indexOf(chatPhase), 0);
    const hasIntroConfig = hasAssetSelectionEvidence(session, 'intro');
    const hasOutroConfig = hasAssetSelectionEvidence(session, 'outro');
    const hasIntentConfig = Boolean(String(session?.edit_notes || '').trim());
    const shouldShowIntroStep = currentStepIndex >= 1 || hasIntroConfig || hasOutroConfig || hasIntentConfig;
    const shouldShowOutroStep = currentStepIndex >= 2 || hasOutroConfig || hasIntentConfig;
    const shouldShowIntentStep = currentStepIndex >= 3 || hasIntentConfig;
    const shouldShowSummaryStep = currentStepIndex >= 4;
    const introAnswered = shouldShowOutroStep || hasIntroConfig || Boolean(introFeedback) || introProcessing || busy === 'outro' || busy === 'intent' || busy === 'start';
    const outroAnswered = shouldShowIntentStep || hasOutroConfig || Boolean(outroFeedback) || outroProcessing || busy === 'intent' || busy === 'start';

    items.push({
      id: 'step-upload',
      role: 'ai',
      content: hasPendingUploadChanges
        ? '파일 변경사항이 있어요. 반영 버튼을 누르면 현재 상태를 다시 확인해드릴게요.'
        : canContinueUpload
        ? '파일을 더 추가하시거나 다음 단계로 진행해주세요.'
        : '원본 영상과 나레이션 파일을 올려주세요. 여러 개를 계속 추가할 수 있습니다.',
      timestamp: now,
    });

    if (rawFiles.length > 0 || audioFiles.length > 0 || uploadFeedback) {
      items.push({
        id: 'upload-status',
        role: 'ai',
        content: uploadProcessing
          ? '변경사항을 반영하고 있어요'
          : (uploadFeedback || `현재 업로드 상태: 영상 ${rawFiles.length}개, 음성 ${audioFiles.length}개`),
        timestamp: now,
      });
    }

    if (shouldShowIntroStep) {
      items.push({
        id: 'step-intro',
        role: 'ai',
        content: '인트로 파일이 있나요?',
        timestamp: now,
      });
    }

    if (introAnswered) {
      items.push({
        id: 'intro-status',
        role: 'ai',
        content: introProcessing
          ? '인트로 변경사항을 반영하고 있어요'
          : (introFeedback || `인트로는 ${introLabel}으로 설정했어요.`),
        timestamp: now,
      });
    }

    if (shouldShowOutroStep) {
      items.push({
        id: 'step-outro',
        role: 'ai',
        content: '아웃트로 파일이 있나요?',
        timestamp: now,
      });
    }

    if (outroAnswered) {
      items.push({
        id: 'outro-status',
        role: 'ai',
        content: outroProcessing
          ? '아웃트로 변경사항을 반영하고 있어요'
          : (outroFeedback || `아웃트로는 ${outroLabel}으로 설정했어요.`),
        timestamp: now,
      });
    }

    if (shouldShowIntentStep) {
      items.push({
        id: 'step-intent',
        role: 'ai',
        content: '편집의도를 작성해주세요.',
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

    if (shouldShowSummaryStep) {
      items.push({
        id: 'step-summary',
        role: 'ai',
        content: '설정 요약입니다. 확인 후 편집을 시작할 수 있습니다.',
        timestamp: now,
      });
    }

    if (busy === 'start') {
      items.push({
        id: 'start-processing',
        role: 'ai',
        content: '요청하신 편집 내용을 확인하고 있어요. 잠시만 기다려주세요.',
        timestamp: now,
      });
    }

    return items;
  }, [audioFiles.length, busy, canContinueUpload, chatPhase, hasPendingUploadChanges, introFeedback, introLabel, introProcessing, outroFeedback, outroLabel, outroProcessing, rawFiles.length, session, uploadFeedback, uploadProcessing]);

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
            <div key={message.id} className="space-y-4">
              <ChatMessage
                role={message.role}
                content={message.content}
                timestamp={message.timestamp}
              />

              {message.id === 'step-upload' ? (
                <div className="ml-12 w-[calc(100%-3rem)] max-w-[calc(100%-3rem)] rounded-3xl border border-slate-200 bg-slate-50 p-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">원본 업로드 창 유지</p>
                      <p className="mt-1 text-sm text-slate-600">AI 질문 바로 아래에서 파일을 추가하거나 삭제할 수 있습니다.</p>
                    </div>
                    <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600">
                      영상 {countDraftFiles(stagedFiles, 'video')} / 음성 {countDraftFiles(stagedFiles, 'audio')}
                    </span>
                  </div>
                  <ChatCard
                    key={`uploader-${session?.id || 'new'}`}
                    type="upload"
                    files={stagedFiles}
                    disabled={busy === 'apply-upload-changes' || loading}
                    onSelectFiles={handleMainUpload}
                    onRemoveFile={handleDeleteFile}
                    removingFileId=""
                  />
                  <div className="mt-3 flex justify-end gap-2">
                    {isUploadEditMode && hasPendingUploadChanges ? (
                      <button
                        type="button"
                        disabled={busy === 'apply-upload-changes'}
                        onClick={handleApplyUploadChanges}
                        className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-300"
                      >
                        변경사항 업로드
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    ) : null}
                    {!isUploadEditMode ? (
                      <button
                        type="button"
                        disabled={busy === 'apply-upload-changes' || uploadProcessing || (!hasPendingUploadChanges && !canContinueUpload)}
                        onClick={handleContinueUploadStep}
                        className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-300"
                      >
                        다음 단계
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {message.id === 'step-intro' ? (
                <div className="ml-12 w-[calc(100%-3rem)] max-w-[calc(100%-3rem)] rounded-3xl border border-violet-100 bg-violet-50/40 p-4">
                  <ChatCard
                    type="intro"
                    value={{
                      mode: session?.intro_mode || 'none',
                      prompt: session?.intro_prompt || '',
                      durationSec: session?.intro_duration_sec || '',
                    }}
                    disabled={busy === 'intro'}
                    submitLabel={isIntroEditMode ? '변경사항 반영' : '설정 반영'}
                    onSubmit={(payload) => handleAssetSubmit('intro', payload)}
                  />
                </div>
              ) : null}

              {message.id === 'step-outro' ? (
                <div className="ml-12 w-[calc(100%-3rem)] max-w-[calc(100%-3rem)] rounded-3xl border border-violet-100 bg-violet-50/40 p-4">
                  <ChatCard
                    type="outro"
                    value={{
                      mode: session?.outro_mode || 'none',
                      prompt: session?.outro_prompt || '',
                      durationSec: session?.outro_duration_sec || '',
                    }}
                    disabled={busy === 'outro'}
                    submitLabel={isOutroEditMode ? '변경사항 반영' : '설정 반영'}
                    onSubmit={(payload) => handleAssetSubmit('outro', payload)}
                  />
                </div>
              ) : null}

              {message.id === 'step-intent' && chatPhase === 'edit_intent' ? (
                <div className="ml-12 w-[calc(100%-3rem)] max-w-[calc(100%-3rem)] rounded-3xl border border-violet-100 bg-violet-50/40 p-4">
                  <ChatCard
                    type="edit_intent"
                    value={session?.edit_notes || ''}
                    disabled={busy === 'intent'}
                    onSubmit={handleIntentSubmit}
                  />
                </div>
              ) : null}

              {message.id === 'step-summary' && chatPhase === 'summary' ? (
                <div className="ml-12 w-[calc(100%-3rem)] max-w-[calc(100%-3rem)] rounded-3xl border border-violet-100 bg-violet-50/40 p-4">
                  <ChatCard
                    type="summary"
                    summary={summary}
                    disabled={busy === 'start'}
                    onStart={handleStartEdit}
                  />
                </div>
              ) : null}
            </div>
          ))}

          {busy && busy !== 'apply-upload-changes' ? (
            <div className="ml-12 flex items-center gap-2 text-sm text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              처리 중...
            </div>
          ) : null}

          {error ? (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}
            </div>
          ) : null}

        </div>
      </div>
    </div>
  );
}
