'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';

let VideoEditorDefault = null;
let TimelineProviderComp = null;
let LivePlayerProviderComp = null;
let INITIAL_TIMELINE = { tracks: [], version: 1 };

try {
  const veModule = require('@twick/video-editor');
  VideoEditorDefault = veModule.default || veModule.VideoEditor;
  const tlModule = require('@twick/timeline');
  TimelineProviderComp = tlModule.TimelineProvider;
  INITIAL_TIMELINE = tlModule.INITIAL_TIMELINE_DATA || INITIAL_TIMELINE;
  const lpModule = require('@twick/live-player');
  LivePlayerProviderComp = lpModule.LivePlayerProvider;
} catch (err) {
  console.warn('[TwickEditorWrapper] Twick 패키지 로드 실패:', err.message);
}

const EDITOR_CONFIG = {
  videoProps: { width: 1920, height: 1080 },
  timelineTickConfigs: [
    { durationThreshold: 30, majorInterval: 5, minorTicks: 5 },
    { durationThreshold: 300, majorInterval: 30, minorTicks: 6 },
    { durationThreshold: 900, majorInterval: 60, minorTicks: 6 },
  ],
  timelineZoomConfig: { min: 0.5, max: 3.0, step: 0.25, default: 1.5 },
  elementColors: {
    video: '#8B5FBF',
    audio: '#3D8B8B',
    image: '#D4956C',
    text: '#A78EC8',
    caption: '#9B8ACE',
    fragment: '#1A1A1A',
  },
};

function useScopedCSS(href) {
  const ref = useRef(null);

  useEffect(() => {
    if (typeof document === 'undefined' || ref.current) return undefined;

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-twick-scoped', 'true');
    document.head.appendChild(link);
    ref.current = link;

    return () => {
      if (ref.current) {
        ref.current.remove();
        ref.current = null;
      }
    };
  }, [href]);
}

function buildMarkerTimelineData(currentStep) {
  const baseVersion = Number(INITIAL_TIMELINE?.version || 1);
  const narration = currentStep?.proposal?.narration;
  if (!narration) {
    return { tracks: [], version: baseVersion };
  }

  const start = Math.max(0, Number(narration.start_s || 0));
  const end = Math.max(start + 0.1, Number(narration.end_s || start + 0.1));
  const topic = String(narration.topic || currentStep?.proposal?.reason || '현재 스텝');

  return {
    tracks: [
      {
        type: 'element',
        id: 't-step-marker',
        name: '현재 스텝',
        elements: [
          {
            id: 'e-step-marker',
            trackId: 't-step-marker',
            name: topic,
            type: 'text',
            s: start,
            e: end,
            props: {
              text: topic,
              fill: '#FFFFFF',
            },
          },
        ],
      },
    ],
    version: baseVersion,
  };
}

export default function TwickEditorWrapper({
  currentStep = null,
  previewUrl = '',
}) {
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);
  const timelineData = useMemo(() => buildMarkerTimelineData(currentStep), [currentStep]);
  const timelineKey = useMemo(() => JSON.stringify({
    stepIndex: currentStep?.step_index ?? null,
    start: currentStep?.proposal?.narration?.start_s ?? null,
    end: currentStep?.proposal?.narration?.end_s ?? null,
  }), [currentStep]);

  useScopedCSS('/twick-editor-scoped.css');

  useEffect(() => {
    setReady(true);
  }, []);

  if (!VideoEditorDefault || !TimelineProviderComp || !LivePlayerProviderComp) {
    return (
      <div style={{
        border: '1px solid #e5e7eb',
        borderRadius: '12px',
        padding: '2rem',
        textAlign: 'center',
        backgroundColor: '#fafafa',
      }}>
        <p style={{ fontWeight: 500, color: '#dc2626' }}>Twick 패키지 로드 실패</p>
        <p style={{ fontSize: '0.875rem', color: '#666', marginTop: '0.5rem' }}>
          @twick/video-editor, @twick/timeline, @twick/live-player 설치를 확인하세요.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        border: '1px solid #fca5a5',
        borderRadius: '12px',
        padding: '2rem',
        backgroundColor: '#fef2f2',
      }}>
        <p style={{ fontWeight: 500, color: '#dc2626' }}>에디터 초기화 오류</p>
        <pre style={{ fontSize: '0.75rem', color: '#666', marginTop: '0.5rem', whiteSpace: 'pre-wrap' }}>
          {String(error)}
        </pre>
      </div>
    );
  }

  return (
    <div className="twick-scope flex h-full min-h-[760px] flex-col overflow-hidden rounded-[24px] border border-slate-200 bg-slate-950">
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950/90 px-5 py-4 text-slate-200">
        <span className="text-sm font-semibold">
          Twick 타임라인 에디터
          {ready && <span className="ml-2 text-xs text-emerald-400">● 준비됨</span>}
        </span>
        <span className="text-xs text-slate-400">CapCut형 편집 레이아웃</span>
      </div>

      {currentStep?.proposal?.narration ? (
        <div className="border-b border-violet-800/60 bg-violet-950/70 px-5 py-3 text-xs text-violet-100">
          현재 스텝 구간: {Number(currentStep.proposal.narration.start_s || 0).toFixed(1)}s ~ {Number(currentStep.proposal.narration.end_s || 0).toFixed(1)}s
          {' · '}
          {currentStep.proposal.narration.topic || currentStep.proposal.reason || '현재 스텝'}
        </div>
      ) : null}

      {previewUrl ? (
        <div className="border-b border-slate-800 bg-black px-5 py-4">
          <video
            key={previewUrl}
            controls
            src={previewUrl}
            className="aspect-video w-full rounded-[20px] border border-slate-800 bg-black object-contain shadow-2xl"
          />
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-3 border-b border-slate-800 bg-slate-900 px-5 py-3 text-xs text-slate-300">
        <div className="rounded-2xl bg-slate-800 px-3 py-2">플레이어: 프리뷰 우선</div>
        <div className="rounded-2xl bg-slate-800 px-3 py-2">타임라인: 현재 스텝 하이라이트</div>
        <div className="rounded-2xl bg-slate-800 px-3 py-2">컨트롤: 확대/이동/검수</div>
      </div>

      <div className="min-h-0 flex-1 bg-slate-950 p-4">
        <ErrorBoundary onError={setError}>
          <LivePlayerProviderComp>
            <TimelineProviderComp key={timelineKey} initialData={timelineData}>
              <div className="h-full overflow-hidden rounded-[20px] border border-slate-800 bg-slate-900">
                <VideoEditorDefault
                  leftPanel={null}
                  rightPanel={null}
                  editorConfig={EDITOR_CONFIG}
                />
              </div>
            </TimelineProviderComp>
          </LivePlayerProviderComp>
        </ErrorBoundary>
      </div>
    </div>
  );
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error) {
    if (typeof this.props.onError === 'function') {
      this.props.onError(error.message || String(error));
    }
  }
  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}
