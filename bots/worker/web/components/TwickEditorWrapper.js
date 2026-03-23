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
    <div className="twick-scope" style={{ border: '1px solid #e5e7eb', borderRadius: '12px', overflow: 'hidden', minHeight: '500px' }}>
      <div style={{
        padding: '0.75rem 1rem',
        borderBottom: '1px solid #e5e7eb',
        backgroundColor: '#f9fafb',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <span style={{ fontWeight: 500, fontSize: '0.875rem' }}>
          Twick 타임라인 에디터
          {ready && <span style={{ color: '#16a34a', marginLeft: '0.5rem', fontSize: '0.75rem' }}>● 준비됨</span>}
        </span>
        <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>Phase 3 테스트</span>
      </div>

      {currentStep?.proposal?.narration ? (
        <div style={{
          padding: '0.75rem 1rem',
          borderBottom: '1px solid #e5e7eb',
          backgroundColor: '#f5f3ff',
          color: '#5b21b6',
          fontSize: '0.75rem',
        }}>
          현재 스텝 구간: {Number(currentStep.proposal.narration.start_s || 0).toFixed(1)}s ~ {Number(currentStep.proposal.narration.end_s || 0).toFixed(1)}s
          {' · '}
          {currentStep.proposal.narration.topic || currentStep.proposal.reason || '현재 스텝'}
        </div>
      ) : null}

      {previewUrl ? (
        <div style={{ padding: '1rem', borderBottom: '1px solid #e5e7eb', backgroundColor: '#fff' }}>
          <video
            key={previewUrl}
            controls
            src={previewUrl}
            style={{ width: '100%', maxHeight: '280px', borderRadius: '12px', backgroundColor: '#000' }}
          />
        </div>
      ) : null}

      <ErrorBoundary onError={setError}>
        <LivePlayerProviderComp>
          <TimelineProviderComp key={timelineKey} initialData={timelineData}>
            <VideoEditorDefault
              leftPanel={null}
              rightPanel={null}
              editorConfig={EDITOR_CONFIG}
            />
          </TimelineProviderComp>
        </LivePlayerProviderComp>
      </ErrorBoundary>
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
