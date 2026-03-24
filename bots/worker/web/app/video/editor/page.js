'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, Loader2 } from 'lucide-react';

import { api } from '@/lib/api';
import EditorChatPanel from '@/components/EditorChatPanel';

const TwickEditor = dynamic(() => import('@/components/TwickEditorWrapper'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-[720px] items-center justify-center rounded-[28px] border border-slate-200 bg-white text-slate-400">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  ),
});

export default function VideoEditorPage() {
  const searchParams = useSearchParams();
  const [mounted, setMounted] = useState(false);
  const [editIdInput, setEditIdInput] = useState('');
  const [editSessionId, setEditSessionId] = useState(null);
  const [steps, setSteps] = useState([]);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState('idle');
  const [previewUrl, setPreviewUrl] = useState('');
  const [error, setError] = useState('');
  const autoStartedRef = useRef(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const initialEditId = String(searchParams?.get('editId') || '').trim();
    if (initialEditId) setEditIdInput(initialEditId);
  }, [searchParams]);

  function getNextStepIndex(nextSteps) {
    const unresolvedIndex = nextSteps.findIndex((step) => !step.user_action);
    return unresolvedIndex === -1 ? Math.max(0, nextSteps.length - 1) : unresolvedIndex;
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

    try {
      setPhase('loading');
      const data = await api.post('/video/steps/generate', { editId: safeEditId });
      setSteps(data.steps || []);
      setEditSessionId(data.sessionId || null);
      setCurrentStepIndex(Number(data.currentStepIndex ?? getNextStepIndex(data.steps || [])));
      setPhase('steps');
    } catch (nextError) {
      setError(nextError.message || '편집 세션 시작에 실패했습니다.');
      setPhase('idle');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!mounted || autoStartedRef.current) return;
    const initialEditId = String(searchParams?.get('editId') || '').trim();
    if (!initialEditId) return;
    autoStartedRef.current = true;
    startEditSession(initialEditId);
  }, [mounted, searchParams]);

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

  async function handleFinalize() {
    if (!editSessionId) return;
    setLoading(true);
    setError('');
    try {
      setPhase('preview');
      const data = await api.post(`/video/steps/${editSessionId}/finalize`, {});
      setSteps(data.steps || steps);
      setCurrentStepIndex(Number(data.currentStepIndex ?? getNextStepIndex(data.steps || steps)));
      setPreviewUrl(data.previewUrl || '');
      setPhase('final');
    } catch (nextError) {
      setError(nextError.message || '프리뷰 생성에 실패했습니다.');
      setPhase('steps');
    } finally {
      setLoading(false);
    }
  }

  const currentStep = useMemo(() => steps[currentStepIndex] || null, [steps, currentStepIndex]);

  if (!mounted) {
    return <div className="p-4 text-sm text-slate-500">편집기를 준비하는 중입니다.</div>;
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col gap-4 p-4 xl:flex-row">
      <div className="flex min-h-0 flex-1 flex-col rounded-[28px] border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-5 py-4">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <div className="flex items-center gap-3">
                <Link href="/video" className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
                  <ArrowLeft className="h-4 w-4" />
                  돌아가기
                </Link>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">phase: {phase}</span>
              </div>
              <h1 className="mt-4 text-2xl font-semibold text-slate-900">영상 편집기</h1>
              <p className="mt-1 text-sm text-slate-500">CapCut형 타임라인과 우측 AI 편집 채팅을 결합한 Phase 3 인터랙티브 편집 화면입니다.</p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                value={editIdInput}
                onChange={(event) => setEditIdInput(event.target.value)}
                placeholder="editId 입력"
                className="rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none"
              />
              <button
                type="button"
                onClick={() => startEditSession(editIdInput)}
                disabled={loading}
                className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-300"
              >
                {loading ? '처리 중...' : '편집 세션 시작'}
              </button>
            </div>
          </div>
          {editSessionId ? (
            <div className="mt-3 text-xs text-violet-600">session: {editSessionId}</div>
          ) : null}
          {error ? (
            <div className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 p-4">
          <TwickEditor currentStep={currentStep} previewUrl={previewUrl} />
        </div>
      </div>

      <div className="min-h-[420px] w-full shrink-0 overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm xl:w-96">
        <EditorChatPanel
          steps={steps}
          currentStepIndex={currentStepIndex}
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
  );
}
