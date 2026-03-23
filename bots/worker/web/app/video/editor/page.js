'use client';

import '@twick/video-editor/dist/video-editor.css';
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';

const TwickEditor = dynamic(() => import('../../../components/TwickEditorWrapper'), {
  ssr: false,
  loading: () => (
    <div style={{ padding: '2rem', textAlign: 'center', color: '#666' }}>
      타임라인 에디터 로딩 중...
    </div>
  ),
});

export default function VideoEditorPage() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div style={{ padding: '2rem' }}>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>영상 편집기 (Phase 3)</h1>
        <p style={{ color: '#666', marginTop: '0.5rem' }}>로딩 중...</p>
      </div>
    );
  }

  return (
    <div style={{ padding: '1rem' }}>
      <h1 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>
        영상 편집기 (Phase 3 — Twick 통합 테스트)
      </h1>
      <div style={{ display: 'flex', height: 'calc(100vh - 120px)', border: '1px solid #e5e7eb', borderRadius: '16px', overflow: 'hidden', background: '#fff' }}>
        <div style={{ width: '320px', borderRight: '1px solid #e5e7eb', padding: '1rem', background: '#fafafa' }}>
          <p style={{ fontWeight: 500, fontSize: '0.875rem' }}>AI 편집 어시스턴트</p>
          <p style={{ fontSize: '0.75rem', color: '#9ca3af', marginTop: '0.5rem', lineHeight: 1.6 }}>
            Phase 3에서 AI 스텝별 제안, RED 평가, BLUE 대안, 사용자 피드백이 여기에 표시됩니다.
          </p>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <TwickEditor />
        </div>
      </div>
    </div>
  );
}
