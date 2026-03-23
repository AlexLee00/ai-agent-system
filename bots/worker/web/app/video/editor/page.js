'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';

import { api } from '@/lib/api';
import StepPanel from '../../../components/StepPanel';
import StepProgressBar from '../../../components/StepProgressBar';

const TwickEditor = dynamic(() => import('../../../components/TwickEditorWrapper'), {
  ssr: false,
  loading: () => (
    <div style={{ padding: '2rem', textAlign: 'center', color: '#666' }}>
      타임라인 에디터 로딩 중...
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
    if (initialEditId) {
      setEditIdInput(initialEditId);
    }
  }, [searchParams]);

  const currentStep = useMemo(() => steps[currentStepIndex] || null, [steps, currentStepIndex]);

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

  if (!mounted) {
    return (
      <div style={{ padding: '2rem' }}>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>영상 편집기 (Phase 3)</h1>
        <p style={{ color: '#666', marginTop: '0.5rem' }}>로딩 중...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">영상 편집기 (Phase 3 — 대화형 편집)</h1>
            <p className="mt-1 text-sm text-slate-500">
              sync_map를 스텝으로 분해하고 RED/BLUE 평가와 사용자 판단을 거쳐 프리뷰를 생성합니다.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              value={editIdInput}
              onChange={(event) => setEditIdInput(event.target.value)}
              placeholder="editId 입력"
              className="rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none ring-0"
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

        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 text-slate-600">phase: {phase}</span>
          {editSessionId ? <span className="rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-violet-700">session: {editSessionId}</span> : null}
          {error ? <span className="rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-rose-700">{error}</span> : null}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
        <div className="min-h-[720px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <StepPanel
            steps={steps}
            currentStepIndex={currentStepIndex}
            onStepClick={setCurrentStepIndex}
            onConfirm={(stepIndex) => handleStepAction(stepIndex, 'confirm')}
            onModify={(stepIndex, modification) => handleStepAction(stepIndex, 'modify', modification)}
            onSkip={(stepIndex) => handleStepAction(stepIndex, 'skip')}
            onAdoptBlue={(stepIndex) => handleStepAction(stepIndex, 'adopt_blue')}
            onFinalize={handleFinalize}
            loading={loading}
          />
        </div>

        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <StepProgressBar
              steps={steps}
              currentStepIndex={currentStepIndex}
              onStepClick={setCurrentStepIndex}
            />
          </div>

          <div className="min-h-[720px]">
            <TwickEditor currentStep={currentStep} previewUrl={previewUrl} />
          </div>
        </div>
      </div>
    </div>
  );
}
