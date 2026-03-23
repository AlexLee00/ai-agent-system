'use client';

import React, { useEffect, useRef, useState } from 'react';

let VideoEditorDefault = null;
let TimelineProviderComp = null;
let LivePlayerProviderComp = null;

try {
  const veModule = require('@twick/video-editor');
  VideoEditorDefault = veModule.default || veModule.VideoEditor;
  const tlModule = require('@twick/timeline');
  TimelineProviderComp = tlModule.TimelineProvider;
  const lpModule = require('@twick/live-player');
  LivePlayerProviderComp = lpModule.LivePlayerProvider;
} catch (err) {
  console.warn('[TwickEditorWrapper] Twick 패키지 로드 실패:', err.message);
}

const INITIAL_TIMELINE = { timeline: [], version: 0 };

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

export default function TwickEditorWrapper() {
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);

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
      <ErrorBoundary onError={setError}>
        <LivePlayerProviderComp>
          <TimelineProviderComp initialData={INITIAL_TIMELINE}>
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
