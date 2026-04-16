// @ts-nocheck
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Clapperboard, Scissors, Sparkles } from 'lucide-react';

import { api } from '@/lib/api';
import { getToken } from '@/lib/auth-context';
import EditorChatPanel from '@/components/EditorChatPanel';
import TwickEditor from '@/components/TwickEditorWrapper';

export default function VideoEditorPage() {
  const [editIdInput, setEditIdInput] = useState('');
  const [editSessionId, setEditSessionId] = useState(null);
  const [steps, setSteps] = useState([]);
  const [editorMode, setEditorMode] = useState('cut');
  const [cutSessionId, setCutSessionId] = useState(null);
  const [cutItems, setCutItems] = useState([]);
  const [cutDrafts, setCutDrafts] = useState({});
  const [currentCutIndex, setCurrentCutIndex] = useState(0);
  const [effectSessionId, setEffectSessionId] = useState(null);
  const [effectItems, setEffectItems] = useState([]);
  const [currentEffectIndex, setCurrentEffectIndex] = useState(0);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState('idle');
  const [previewUrl, setPreviewUrl] = useState('');
  const [framePreviewUrl, setFramePreviewUrl] = useState('');
  const [error, setError] = useState('');
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const autoStartedRef = useRef(false);
  const videoObjectUrlRef = useRef('');
  const frameObjectUrlRef = useRef('');

  useEffect(() => () => {
    if (videoObjectUrlRef.current) URL.revokeObjectURL(videoObjectUrlRef.current);
    if (frameObjectUrlRef.current) URL.revokeObjectURL(frameObjectUrlRef.current);
    videoObjectUrlRef.current = '';
    frameObjectUrlRef.current = '';
  }, []);

  useEffect(() => {
    function syncViewport() {
      setIsMobileViewport(window.innerWidth < 1024);
    }
    syncViewport();
    window.addEventListener('resize', syncViewport);
    return () => window.removeEventListener('resize', syncViewport);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const initialEditId = String(params.get('editId') || '').trim();
    if (initialEditId) setEditIdInput(initialEditId);
  }, []);

  function getNextStepIndex(nextSteps) {
    const unresolvedIndex = nextSteps.findIndex((step) => !step.user_action);
    return unresolvedIndex === -1 ? Math.max(0, nextSteps.length - 1) : unresolvedIndex;
  }

  function getNextCutIndex(nextItems) {
    const unresolvedIndex = nextItems.findIndex((item) => !item.user_action);
    return unresolvedIndex === -1 ? Math.max(0, nextItems.length - 1) : unresolvedIndex;
  }

  async function loadProtectedBlobUrl(url, objectUrlRef, setter) {
    const token = getToken();
    const response = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (response.status === 401) {
      throw new Error('인증 만료');
    }
    if (!response.ok) {
      throw new Error('보호된 미디어를 불러오지 못했습니다.');
    }
    const blob = await response.blob();
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
    }
    const objectUrl = URL.createObjectURL(blob);
    objectUrlRef.current = objectUrl;
    setter(objectUrl);
    return objectUrl;
  }

  async function loadProtectedVideoUrl(url) {
    return loadProtectedBlobUrl(url, videoObjectUrlRef, setPreviewUrl);
  }

  async function loadProtectedFrameUrl(url) {
    return loadProtectedBlobUrl(url, frameObjectUrlRef, setFramePreviewUrl);
  }

  async function startStepSession(editId) {
    const data = await api.post('/video/steps/generate', { editId });
    setSteps(data.steps || []);
    setEditSessionId(data.sessionId || null);
    setCurrentStepIndex(Number(data.currentStepIndex ?? getNextStepIndex(data.steps || [])));
    if (!videoObjectUrlRef.current) {
      await loadProtectedVideoUrl(`/api/video/steps/edit-${editId}/source-video?t=${Date.now()}`);
    }
    setEditorMode('steps');
    setPhase('steps');
  }

  async function startEditSession(editId) {
    const safeEditId = Number(editId);
    if (!Number.isFinite(safeEditId) || safeEditId <= 0) {
      setError('유효한 editId를 입력하세요.');
      return;
    }

    setLoading(true);
    setError('');
    setPreviewUrl('');
    setFramePreviewUrl('');
    setSteps([]);
    setEditSessionId(null);
    setCutItems([]);
    setCutSessionId(null);
    setCutDrafts({});
    setEffectItems([]);
    setEffectSessionId(null);

    try {
      setPhase('loading');
      await loadProtectedVideoUrl(`/api/video/steps/edit-${safeEditId}/source-video?t=${Date.now()}`);
      const cutData = await api.post('/video/steps/cut/generate', { editId: safeEditId });
      setCutItems(cutData.items || []);
      setCutSessionId(cutData.sessionId || null);
      setCutDrafts({});
      setCurrentCutIndex(Number(cutData.currentItemIndex ?? getNextCutIndex(cutData.items || [])));
      setEditorMode('cut');
      setPhase(cutData.phase || 'cut-review');
    } catch (nextError) {
      setError(nextError.message || '편집 세션 시작에 실패했습니다.');
      setPhase('idle');
    } finally {
      setLoading(false);
    }
  }

  async function startEffectSession(editId) {
    const data = await api.post('/video/steps/effect/generate', { editId });
    setEffectItems(data.items || []);
    setEffectSessionId(data.sessionId || null);
    setCurrentEffectIndex(Number(data.currentItemIndex ?? getNextStepIndex(data.items || [])));
    setEditorMode('effect');
    setPhase(data.phase || 'effect-review');
  }

  useEffect(() => {
    if (autoStartedRef.current) return;
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const initialEditId = String(params.get('editId') || '').trim();
    if (!initialEditId) return;
    autoStartedRef.current = true;
    startEditSession(initialEditId);
  }, []);

  useEffect(() => {
    if (editorMode !== 'cut') {
      setFramePreviewUrl('');
      return;
    }
    const currentCutItem = cutItems[currentCutIndex];
    if (!currentCutItem) {
      setFramePreviewUrl('');
      return;
    }
    const atSeconds = Math.max(0, Number(currentCutItem.proposal_start_ms || 0) / 1000 + 0.05);
    loadProtectedFrameUrl(`/api/video/steps/edit-${editIdInput}/frame-preview?at=${atSeconds}&t=${Date.now()}`).catch(() => {
      setFramePreviewUrl('');
    });
  }, [cutItems, currentCutIndex, editIdInput, editorMode]);

  async function handleStepAction(stepIndex, action, modification = null) {
    if (!editSessionId) return;
    setLoading(true);
    setError('');
    try {
      const data = await api.post(`/video/steps/${editSessionId}/action`, {
        stepIndex,
        action,
        modification,
      });
      setSteps(data.steps || []);
      setCurrentStepIndex(Number(data.nextStepIndex ?? getNextStepIndex(data.steps || [])));
    } catch (nextError) {
      setError(nextError.message || '스텝 액션 처리에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCutAction(itemIndex, action, modification = null) {
    if (!cutSessionId) return;
    setLoading(true);
    setError('');
    try {
      const data = await api.post(`/video/steps/cut/${cutSessionId}/action`, {
        itemIndex,
        action,
        modification,
      });
      setCutItems(data.items || []);
      setCutDrafts((prev) => {
        const next = { ...prev };
        delete next[itemIndex];
        return next;
      });
      setCurrentCutIndex(Number(data.currentItemIndex ?? getNextCutIndex(data.items || [])));
      setPhase(data.phase || 'cut-review');
    } catch (nextError) {
      setError(nextError.message || '컷 편집 액션 처리에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCutFinalize() {
    if (!cutSessionId) return;
    setLoading(true);
    setError('');
    try {
      const data = await api.post(`/video/steps/cut/${cutSessionId}/confirm`, {});
      setCutItems(data.items || cutItems);
      setCurrentCutIndex(Number(data.currentItemIndex ?? getNextCutIndex(data.items || cutItems)));
      await startEffectSession(editIdInput);
    } catch (nextError) {
      setError(nextError.message || '컷 편집 확정에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }

  async function handleEffectAction(itemIndex, action, modification = null) {
    if (!effectSessionId) return;
    setLoading(true);
    setError('');
    try {
      const data = await api.post(`/video/steps/effect/${effectSessionId}/action`, {
        itemIndex,
        action,
        modification,
      });
      setEffectItems(data.items || []);
      setCurrentEffectIndex(Number(data.currentItemIndex ?? getNextStepIndex(data.items || [])));
      setPhase(data.phase || 'effect-review');
    } catch (nextError) {
      setError(nextError.message || '효과 삽입 액션 처리에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }

  async function handleEffectFinalize() {
    if (!effectSessionId) return;
    setLoading(true);
    setError('');
    try {
      const data = await api.post(`/video/steps/effect/${effectSessionId}/confirm`, {});
      setEffectItems(data.items || effectItems);
      setCurrentEffectIndex(Number(data.currentItemIndex ?? getNextStepIndex(data.items || effectItems)));
      await startStepSession(editIdInput);
    } catch (nextError) {
      setError(nextError.message || '효과 삽입 확정에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }

  async function handleFinalize() {
    if (!editSessionId) return;
    setLoading(true);
    setError('');
    try {
      setPhase('preview');
      const data = await api.post(`/video/steps/${editSessionId}/finalize`, {});
      setSteps(data.steps || steps);
      setCurrentStepIndex(Number(data.currentStepIndex ?? getNextStepIndex(data.steps || steps)));
      if (data.previewUrl) {
        await loadProtectedVideoUrl(data.previewUrl);
      }
      setPhase('final');
    } catch (nextError) {
      setError(nextError.message || '프리뷰 생성에 실패했습니다.');
      setPhase('steps');
    } finally {
      setLoading(false);
    }
  }

  function handleCutDraftChange(itemIndex, nextDraft) {
    setCutDrafts((prev) => ({
      ...prev,
      [itemIndex]: {
        ...prev[itemIndex],
        ...nextDraft,
      },
    }));
  }

  async function handleCutConfirm(itemIndex) {
    const item = cutItems.find((candidate) => Number(candidate.item_index) === Number(itemIndex));
    if (!item) return;
    const draft = cutDrafts[itemIndex];
    const hasBoundsDraft = draft
      && (Number(draft.start_ms) !== Number(item.proposal_start_ms)
        || Number(draft.end_ms) !== Number(item.proposal_end_ms));

    if (hasBoundsDraft) {
      await handleCutAction(itemIndex, 'modify', {
        start_ms: draft.start_ms,
        end_ms: draft.end_ms,
        reason: draft.operator_note || item.reason_text,
        operator_note: draft.operator_note || null,
      });
      return;
    }

    await handleCutAction(itemIndex, 'confirm');
  }

  const currentStep = useMemo(() => steps[currentStepIndex] || null, [steps, currentStepIndex]);
  const currentCutItem = useMemo(() => cutItems[currentCutIndex] || null, [cutItems, currentCutIndex]);
  const currentEffectItem = useMemo(() => effectItems[currentEffectIndex] || null, [effectItems, currentEffectIndex]);
  const currentCutDraft = useMemo(() => {
    if (!currentCutItem) return null;
    const draft = cutDrafts[currentCutItem.item_index];
    return {
      start_ms: Number(draft?.start_ms ?? currentCutItem.proposal_start_ms),
      end_ms: Number(draft?.end_ms ?? currentCutItem.proposal_end_ms),
      operator_note: draft?.operator_note || '',
    };
  }, [currentCutItem, cutDrafts]);

  if (isMobileViewport) {
    return (
      <div className="flex h-[calc(100vh-4rem)] items-center justify-center p-4">
        <div className="max-w-md rounded-3xl border border-amber-200 bg-amber-50 px-6 py-8 text-center">
          <p className="text-sm font-semibold text-amber-700">PC 전용 메뉴입니다.</p>
          <p className="mt-2 text-sm leading-6 text-amber-800">영상 편집기는 PC에서 이용해주세요.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[30px] border border-slate-900 bg-[#111214] shadow-[0_24px_80px_rgba(0,0,0,0.4)]">
      <div className="shrink-0 border-b border-slate-800 bg-[#1b1c1f] px-5 py-3">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex items-start gap-6">
            <div>
              <div className="flex items-center gap-3">
                <Link href="/video" className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-[#26272b] px-3 py-2 text-sm font-medium text-slate-200 hover:bg-[#2d2f33]">
                  <ArrowLeft className="h-4 w-4" />
                  돌아가기
                </Link>
                <span className="rounded-full bg-slate-800 px-3 py-1 text-xs font-semibold text-slate-300">phase: {phase}</span>
              </div>
              <h1 className="mt-4 text-2xl font-semibold text-white">영상 편집기</h1>
              <p className="mt-1 text-sm text-slate-400">캡컷형 레이아웃을 참고한 단계형 편집 워크스페이스입니다.</p>
            </div>
            <div className="hidden items-center gap-3 xl:flex">
              {[
                { icon: Clapperboard, label: '컷 편집' },
                { icon: Sparkles, label: '효과 삽입' },
                { icon: Scissors, label: '타임라인' },
              ].map((item) => (
                <div key={item.label} className="flex items-center gap-2 rounded-2xl border border-slate-800 bg-[#232428] px-3 py-2 text-xs text-slate-300">
                  <item.icon className="h-4 w-4 text-cyan-300" />
                  {item.label}
                </div>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              value={editIdInput}
              onChange={(event) => setEditIdInput(event.target.value)}
              placeholder="editId 입력"
              className="rounded-xl border border-slate-700 bg-[#232428] px-3 py-2 text-sm text-slate-100 outline-none"
            />
            <button
              type="button"
              onClick={() => startEditSession(editIdInput)}
              disabled={loading}
              className="rounded-xl bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:bg-slate-700 disabled:text-slate-400"
            >
              {loading ? '처리 중...' : '편집 세션 시작'}
            </button>
          </div>
        </div>
        {editSessionId ? (
          <div className="mt-3 text-xs text-cyan-300">session: {editSessionId}</div>
        ) : null}
        {error ? (
          <div className="mt-3 rounded-2xl border border-rose-500/30 bg-rose-950/50 px-4 py-3 text-sm text-rose-200">{error}</div>
        ) : null}
      </div>

      <div className="min-h-0 flex flex-1 gap-4 overflow-hidden p-4">
        <div className="min-h-0 flex-1 overflow-hidden rounded-[26px] border border-slate-800 bg-[#0f1012]">
          <TwickEditor
            mode={editorMode}
            cutItems={cutItems}
            currentCutItem={currentCutItem}
            currentCutDraft={currentCutDraft}
            effectItems={effectItems}
            currentEffectItem={currentEffectItem}
            onCutDraftChange={(nextDraft) => {
              if (!currentCutItem) return;
              handleCutDraftChange(currentCutItem.item_index, nextDraft);
            }}
            currentStep={currentStep}
        previewUrl={previewUrl}
        framePreviewUrl={framePreviewUrl}
      />
        </div>

        <div className="min-h-0 w-full shrink-0 overflow-hidden rounded-[26px] border border-slate-800 bg-[#17181b] xl:w-[360px]">
          <EditorChatPanel
            mode={editorMode}
            steps={steps}
            cutItems={cutItems}
            effectItems={effectItems}
            currentCutDraft={currentCutDraft}
            currentCutIndex={currentCutIndex}
            currentEffectIndex={currentEffectIndex}
            currentStepIndex={currentStepIndex}
            onCutItemClick={setCurrentCutIndex}
            onCutConfirm={handleCutConfirm}
            onCutModify={(itemIndex, modification) => {
              const item = cutItems.find((candidate) => Number(candidate.item_index) === Number(itemIndex));
              const draft = cutDrafts[itemIndex];
              return handleCutAction(itemIndex, 'modify', {
                start_ms: draft?.start_ms ?? item?.proposal_start_ms,
                end_ms: draft?.end_ms ?? item?.proposal_end_ms,
                ...modification,
              });
            }}
            onCutSkip={(itemIndex) => handleCutAction(itemIndex, 'skip')}
            onCutFinalize={handleCutFinalize}
            onEffectItemClick={setCurrentEffectIndex}
            onEffectConfirm={(itemIndex) => handleEffectAction(itemIndex, 'confirm')}
            onEffectSkip={(itemIndex) => handleEffectAction(itemIndex, 'skip')}
            onEffectModify={(itemIndex, modification) => handleEffectAction(itemIndex, 'modify', modification)}
            onEffectFinalize={handleEffectFinalize}
            onStepClick={setCurrentStepIndex}
            onConfirm={(stepIndex) => handleStepAction(stepIndex, 'confirm')}
            onModify={(stepIndex, modification) => handleStepAction(stepIndex, 'modify', modification)}
            onSkip={(stepIndex) => handleStepAction(stepIndex, 'skip')}
            onAdoptBlue={(stepIndex) => handleStepAction(stepIndex, 'adopt_blue')}
            onFinalize={handleFinalize}
            loading={loading}
            phase={phase}
          />
        </div>
      </div>
    </div>
  );
}
