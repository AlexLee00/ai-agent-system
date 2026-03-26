'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Clapperboard,
  ImageIcon,
  LayoutGrid,
  ListVideo,
  MonitorUp,
  Music2,
  Pause,
  Play,
  Sparkles,
  SlidersHorizontal,
  Type,
  Volume2,
  VolumeX,
} from 'lucide-react';

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

const EDITOR_CONFIG_BASE = {
  videoProps: { width: 1920, height: 1080 },
  timelineTickConfigs: [
    { durationThreshold: 30, majorInterval: 5, minorTicks: 5 },
    { durationThreshold: 300, majorInterval: 30, minorTicks: 6 },
    { durationThreshold: 900, majorInterval: 60, minorTicks: 6 },
  ],
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

function buildMarkerTimelineData(currentStep, cutItems = [], mode = 'steps', totalDurationSeconds = 0) {
  const baseVersion = Number(INITIAL_TIMELINE?.version || 1);
  if (mode === 'cut') {
    const items = Array.isArray(cutItems) ? cutItems : [];
    if (items.length === 0) {
      return { tracks: [], version: baseVersion };
    }

    const elements = items.map((item, index) => ({
      id: `e-cut-marker-${index}`,
      trackId: 't-cut-markers',
      name: `컷 제안 ${index + 1}`,
      type: 'text',
      s: Number(item.proposal_start_ms || 0) / 1000,
      e: Math.max(
        Number(item.proposal_end_ms || 0) / 1000,
        (Number(item.proposal_start_ms || 0) / 1000) + 0.1
      ),
      props: {
        text: `컷 ${index + 1}`,
        fill: '#F8FAFC',
      },
    }));

    if (totalDurationSeconds > 0) {
      elements.push({
        id: 'e-cut-duration-anchor',
        trackId: 't-cut-markers',
        name: 'duration-anchor',
        type: 'text',
        s: Math.max(0, totalDurationSeconds - 0.05),
        e: totalDurationSeconds,
        props: {
          text: '',
          fill: 'rgba(0,0,0,0)',
        },
      });
    }

    return {
      tracks: [
        {
          type: 'element',
          id: 't-cut-markers',
          name: '컷 제안 구간',
          elements,
        },
      ],
      version: baseVersion,
    };
  }

  const narration = currentStep?.proposal?.narration;
  if (!narration) {
    return { tracks: [], version: baseVersion };
  }

  const start = Math.max(0, Number(narration.start_s || 0));
  const end = Math.max(start + 0.1, Number(narration.end_s || start + 0.1));
  const topic = String(narration.topic || currentStep?.proposal?.reason || '현재 스텝');

  const elements = [
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
  ];

  if (totalDurationSeconds > 0) {
    elements.push({
      id: 'e-step-duration-anchor',
      trackId: 't-step-marker',
      name: 'duration-anchor',
      type: 'text',
      s: Math.max(0, totalDurationSeconds - 0.05),
      e: totalDurationSeconds,
      props: {
        text: '',
        fill: 'rgba(0,0,0,0)',
      },
    });
  }

  return {
    tracks: [
      {
        type: 'element',
        id: 't-step-marker',
        name: '현재 스텝',
        elements,
      },
    ],
    version: baseVersion,
  };
}

export default function TwickEditorWrapper({
  mode = 'steps',
  cutItems = [],
  currentCutItem = null,
  currentCutDraft = null,
  effectItems = [],
  currentEffectItem = null,
  currentStep = null,
  previewUrl = '',
  framePreviewUrl = '',
}) {
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);
  const [activeAssetTab, setActiveAssetTab] = useState('media');
  const [isPlayingPreview, setIsPlayingPreview] = useState(false);
  const [playerCurrentTime, setPlayerCurrentTime] = useState(0);
  const [playerDuration, setPlayerDuration] = useState(0);
  const [playerMuted, setPlayerMuted] = useState(false);
  const editorHostRef = useRef(null);
  const videoRef = useRef(null);
  const editorConfig = useMemo(() => ({
    ...EDITOR_CONFIG_BASE,
    timelineZoomConfig: mode === 'cut' || mode === 'effect'
      ? { min: 0.05, max: 1.5, step: 0.05, default: 0.1 }
      : { min: 0.1, max: 2.0, step: 0.1, default: 0.6 },
  }), [mode]);
  const timelineData = useMemo(
    () => buildMarkerTimelineData(
      mode === 'effect' ? currentEffectItem : currentStep,
      mode === 'cut' ? cutItems : effectItems,
      mode,
      playerDuration
    ),
    [currentStep, currentEffectItem, cutItems, effectItems, mode, playerDuration]
  );
  const timelineKey = useMemo(() => JSON.stringify({
    mode,
    stepIndex: currentStep?.step_index ?? null,
    cutIndex: currentCutItem?.item_index ?? null,
    effectIndex: currentEffectItem?.step_index ?? null,
    start: currentStep?.proposal?.narration?.start_s ?? null,
    end: currentStep?.proposal?.narration?.end_s ?? null,
    duration: playerDuration,
  }), [currentStep, currentCutItem, currentEffectItem, mode, playerDuration]);

  useScopedCSS('/twick-editor-scoped.css');

  useEffect(() => {
    setReady(true);
  }, []);

  useEffect(() => {
    if (mode !== 'cut' || !currentCutItem || !videoRef.current) return;
    const node = videoRef.current;
    const nextTime = Math.max(0, Number(currentCutItem.proposal_start_ms || 0) / 1000 + 0.05);
    try {
      node.currentTime = nextTime;
      node.pause();
      setIsPlayingPreview(false);
    } catch (_error) {
      // metadata 전에는 currentTime 이동이 실패할 수 있으므로 무시
    }
  }, [currentCutItem, mode]);

  useEffect(() => {
    const node = videoRef.current;
    if (!node) return undefined;

    function syncPlayerState() {
      setPlayerCurrentTime(Number.isFinite(node.currentTime) ? node.currentTime : 0);
      setPlayerDuration(Number.isFinite(node.duration) ? node.duration : 0);
      setPlayerMuted(Boolean(node.muted));
    }

    syncPlayerState();
    node.addEventListener('loadedmetadata', syncPlayerState);
    node.addEventListener('timeupdate', syncPlayerState);
    node.addEventListener('durationchange', syncPlayerState);
    node.addEventListener('volumechange', syncPlayerState);
    return () => {
      node.removeEventListener('loadedmetadata', syncPlayerState);
      node.removeEventListener('timeupdate', syncPlayerState);
      node.removeEventListener('durationchange', syncPlayerState);
      node.removeEventListener('volumechange', syncPlayerState);
    };
  }, [previewUrl]);

  useEffect(() => {
    const host = editorHostRef.current;
    if (!host) return undefined;

    function syncEditorBounds() {
      const container = host.querySelector('.twick-editor-container');
      const main = host.querySelector('.twick-editor-main-container');
      const view = host.querySelector('.twick-editor-view-section');
      const timeline = host.querySelector('.twick-editor-timeline-section');
      const player = host.querySelector('twick-player');
      const canvases = host.querySelectorAll('canvas');
      const canvasContainer = host.querySelector('.twick-editor-canvas-container .canvas-container');
      const timelineScrollRoot = host.querySelector('.twick-timeline-scroll-container > div');
      const seekTrackCanvas = host.querySelector('.twick-seek-track-container-no-scrollbar > div');
      const playhead = host.querySelector('.twick-seek-track-playhead');
      const playheadPin = host.querySelector('.twick-seek-track-pin');
      const track = host.querySelector('.twick-track');
      const timelineSizedNodes = host.querySelectorAll(
        '.twick-editor-canvas-container .canvas-container, ' +
        '.twick-timeline-scroll-container > div, ' +
        '.twick-timeline-scroll-container > div > div, ' +
        '.twick-seek-track-container-no-scrollbar > div, ' +
        '.twick-track'
      );

      if (main) {
        main.style.minHeight = '0';
        main.style.height = '100%';
        main.style.overflow = 'hidden';
      }
      if (view) {
        view.style.display = 'none';
        view.style.minHeight = '0';
        view.style.height = '0';
        view.style.overflow = 'hidden';
        view.style.alignItems = 'center';
        view.style.justifyContent = 'center';
      }
      if (timeline) {
        timeline.style.minHeight = '0';
        timeline.style.height = '100%';
        timeline.style.maxHeight = '100%';
        timeline.style.overflow = 'hidden';
      }
      if (main) {
        main.style.gridTemplateRows = 'minmax(0, 1fr)';
      }
      if (container) {
        container.style.aspectRatio = 'auto';
        container.style.width = '100%';
        container.style.height = '100%';
        container.style.maxWidth = '100%';
        container.style.maxHeight = '100%';
        container.style.minWidth = '0';
        container.style.minHeight = '0';
        container.style.margin = '0 auto';
        container.style.overflow = 'hidden';
      }
      if (player) {
        player.style.width = '100%';
        player.style.height = '100%';
        player.style.maxWidth = '100%';
        player.style.maxHeight = '100%';
        player.style.overflow = 'hidden';
      }
      if (canvasContainer) {
        canvasContainer.style.width = '100%';
        canvasContainer.style.maxWidth = '100%';
        canvasContainer.style.height = '100%';
        canvasContainer.style.maxHeight = '100%';
        canvasContainer.style.overflow = 'hidden';
      }
      if (timelineScrollRoot) {
        timelineScrollRoot.style.width = '100%';
        timelineScrollRoot.style.maxWidth = '100%';
      }
      if (seekTrackCanvas) {
        seekTrackCanvas.style.width = '100%';
        seekTrackCanvas.style.maxWidth = '100%';
      }
      if (track) {
        track.style.width = '100%';
        track.style.maxWidth = '100%';
      }
      if (playhead) {
        playhead.style.width = 'auto';
        playhead.style.maxWidth = 'none';
      }
      if (playheadPin) {
        playheadPin.style.maxHeight = '100%';
      }
      timelineSizedNodes.forEach((node) => {
        node.style.width = '100%';
        node.style.maxWidth = '100%';
        node.style.minWidth = '0';
      });
      canvases.forEach((canvas) => {
        canvas.setAttribute('width', '1920');
        canvas.style.width = '100%';
        canvas.style.maxWidth = '100%';
        canvas.style.minWidth = '0';
        canvas.style.maxHeight = '100%';
      });
    }

    syncEditorBounds();
    const observer = new ResizeObserver(() => syncEditorBounds());
    observer.observe(host);
    const raf = window.requestAnimationFrame(syncEditorBounds);
    return () => {
      window.cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [mode, previewUrl, currentCutItem?.item_index, currentEffectItem?.step_index, currentStep?.step_index]);

  useEffect(() => {
    const host = editorHostRef.current;
    if (!host || playerDuration <= 0) return undefined;

    function syncTimelinePlayback() {
      const ratio = Math.max(0, Math.min(1, playerCurrentTime / playerDuration));
      const seekSurface = host.querySelector('.twick-seek-track-container-no-scrollbar > div');
      const playhead = host.querySelector('.twick-seek-track-playhead');
      const currentTimeLabel = host.querySelector('.current-time');
      const totalTimeLabel = host.querySelector('.total-time');
      const progressInput = host.querySelector('.twick-seek-track-container-no-scrollbar input[type="range"]');
      const activeFill = host.querySelector('.twick-seek-track-container-no-scrollbar input[type="range"]')?.previousElementSibling;
      const surfaceWidth = seekSurface?.clientWidth || 0;

      if (playhead && surfaceWidth > 0) {
        playhead.style.transform = `translateX(${ratio * surfaceWidth}px)`;
      }
      if (currentTimeLabel) {
        currentTimeLabel.textContent = `${formatPlayerTime(playerCurrentTime)}.00`;
      }
      if (totalTimeLabel) {
        totalTimeLabel.textContent = `${formatPlayerTime(playerDuration)}.00`;
      }
      if (progressInput) {
        progressInput.max = String(playerDuration);
        progressInput.value = String(playerCurrentTime);
      }
      if (activeFill && activeFill instanceof HTMLElement) {
        activeFill.style.width = `${ratio * 100}%`;
      }
    }

    syncTimelinePlayback();
    const raf = window.requestAnimationFrame(syncTimelinePlayback);
    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, [playerCurrentTime, playerDuration, timelineKey]);

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

  const cutDraftStart = Number(currentCutDraft?.start_ms ?? currentCutItem?.proposal_start_ms ?? 0);
  const cutDraftEnd = Number(currentCutDraft?.end_ms ?? currentCutItem?.proposal_end_ms ?? 0);
  const playerProgress = playerDuration > 0 ? Math.min(100, (playerCurrentTime / playerDuration) * 100) : 0;

  function formatPlayerTime(seconds) {
    const safeSeconds = Math.max(0, Math.floor(Number(seconds || 0)));
    const minutes = Math.floor(safeSeconds / 60);
    const remainSeconds = safeSeconds % 60;
    return `${minutes}:${String(remainSeconds).padStart(2, '0')}`;
  }

  function seekPreviewTo(nextTime) {
    const node = videoRef.current;
    if (!node) return;
    const boundedTime = Math.max(0, Math.min(Number(nextTime || 0), Number.isFinite(node.duration) ? node.duration : Number(nextTime || 0)));
    try {
      node.currentTime = boundedTime;
    } catch {
      return;
    }
    setPlayerCurrentTime(boundedTime);
  }

  function handleTogglePlayback() {
    const node = videoRef.current;
    if (!node) return;
    if (node.paused) {
      node.play().catch(() => {});
    } else {
      node.pause();
    }
  }

  function handleSeekPreview(event) {
    seekPreviewTo(Number(event.target.value));
  }

  function handleToggleMute() {
    const node = videoRef.current;
    if (!node) return;
    node.muted = !node.muted;
    setPlayerMuted(node.muted);
  }

  useEffect(() => {
    const host = editorHostRef.current;
    const node = videoRef.current;
    if (!host || !node) return undefined;

    function onTimelineRangeInput(event) {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (!target.closest('.twick-seek-track-container-no-scrollbar')) return;
      seekPreviewTo(Number(target.value));
    }

    function onTimelineButtonClick(event) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest('button');
      if (!(button instanceof HTMLButtonElement)) return;
      const title = String(button.getAttribute('title') || '').trim();
      if (!title) return;

      if (title === 'Play') {
        event.preventDefault();
        event.stopPropagation();
        handleTogglePlayback();
        return;
      }

      if (title === 'Jump to start') {
        event.preventDefault();
        event.stopPropagation();
        seekPreviewTo(0);
        node.pause();
        setIsPlayingPreview(false);
        return;
      }

      if (title === 'Jump to end') {
        event.preventDefault();
        event.stopPropagation();
        const endTime = Number.isFinite(node.duration) ? Math.max(0, node.duration - 0.05) : 0;
        seekPreviewTo(endTime);
        node.pause();
        setIsPlayingPreview(false);
      }
    }

    host.addEventListener('input', onTimelineRangeInput, true);
    host.addEventListener('change', onTimelineRangeInput, true);
    host.addEventListener('click', onTimelineButtonClick, true);
    return () => {
      host.removeEventListener('input', onTimelineRangeInput, true);
      host.removeEventListener('change', onTimelineRangeInput, true);
      host.removeEventListener('click', onTimelineButtonClick, true);
    };
  }, [timelineKey, playerDuration, isPlayingPreview]);

  const assetTabs = [
    { id: 'media', label: '미디어', icon: ImageIcon },
    { id: 'text', label: '텍스트', icon: Type },
    { id: 'audio', label: '오디오', icon: Music2 },
    { id: 'effects', label: '효과', icon: Sparkles },
  ];
  const assetCards = useMemo(() => {
    if (activeAssetTab === 'media') {
      const mediaSource = mode === 'effect'
        ? (Array.isArray(effectItems) ? effectItems : [])
        : (Array.isArray(cutItems) ? cutItems : []);
      return mediaSource.slice(0, 8).map((item, index) => ({
        key: `media-${mode}-${item.item_index ?? item.step_index ?? index}`,
        title: mode === 'effect' ? `효과 후보 ${index + 1}` : `컷 후보 ${index + 1}`,
        subtitle: mode === 'effect'
          ? `${item.effect?.effect_label || '효과'} · ${(Number(item.proposal?.narration?.start_s || 0)).toFixed(1)}s`
          : `${(Number(item.proposal_start_ms || 0) / 1000).toFixed(1)}s - ${(Number(item.proposal_end_ms || 0) / 1000).toFixed(1)}s`,
        accent: 'cyan',
      }));
    }
    if (activeAssetTab === 'text') {
      return [
        { key: 'text-1', title: '자막 강조', subtitle: '컷 이후 핵심 문장 강조용 텍스트', accent: 'violet' },
        { key: 'text-2', title: '챕터 라벨', subtitle: '단계 전환 시 제목 카드', accent: 'violet' },
        { key: 'text-3', title: '포인트 캡션', subtitle: '효과 삽입 단계와 연결 예정', accent: 'violet' },
      ];
    }
    if (activeAssetTab === 'audio') {
      return [
        { key: 'audio-1', title: '내레이션 원본', subtitle: '컷 이후 음성 재배치 대상', accent: 'emerald' },
        { key: 'audio-2', title: '배경음 슬롯', subtitle: '후속 단계에서 추천/삽입', accent: 'emerald' },
      ];
    }
    return [
      { key: 'fx-1', title: '확대', subtitle: '중요 구간 확대 효과', accent: 'amber' },
      { key: 'fx-2', title: '포인터', subtitle: '버튼/입력 위치 강조', accent: 'amber' },
      { key: 'fx-3', title: '슬라이드', subtitle: '장면 전환 효과', accent: 'amber' },
    ];
  }, [activeAssetTab, cutItems, effectItems, mode]);

  return (
    <div className="twick-scope flex h-full min-h-0 flex-col overflow-hidden bg-[#101114] text-slate-100">
      <div className="flex items-center justify-between border-b border-slate-800 bg-[#18191d] px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-slate-300">
          {[Clapperboard, Type, Music2, LayoutGrid, SlidersHorizontal].map((Icon, index) => (
            <button
              key={index}
              type="button"
              className={`inline-flex h-9 w-9 items-center justify-center rounded-xl border ${
                index === 0 ? 'border-cyan-400/30 bg-cyan-400/10 text-cyan-300' : 'border-slate-800 bg-[#222328] text-slate-400'
              }`}
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
        </div>
        <span className="text-sm font-semibold text-slate-200">
          CapCut형 편집 레이아웃
          {ready && <span className="ml-2 text-xs text-emerald-400">● 준비됨</span>}
        </span>
      </div>

      <div className="min-h-0 flex flex-1 overflow-hidden">
        <div className="hidden w-[268px] shrink-0 border-r border-slate-800 bg-[#1a1b1f] xl:flex xl:flex-col">
          <div className="border-b border-slate-800 px-4 py-3">
            <div className="grid grid-cols-4 gap-2">
              {assetTabs.map((tab) => {
                const Icon = tab.icon;
                const active = activeAssetTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveAssetTab(tab.id)}
                    className={`flex flex-col items-center gap-1 rounded-2xl border px-2 py-2 text-[11px] font-medium ${
                      active
                        ? 'border-cyan-400/30 bg-cyan-400/10 text-cyan-300'
                        : 'border-slate-800 bg-[#24262b] text-slate-400 hover:bg-[#2a2d33]'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="border-b border-slate-800 px-4 py-3">
            <div className="rounded-2xl border border-slate-700 bg-[#24262b] px-3 py-2 text-xs text-slate-400">
              {activeAssetTab === 'media' ? '미디어 검색' : activeAssetTab === 'text' ? '텍스트 프리셋' : activeAssetTab === 'audio' ? '오디오 소스' : '효과 프리셋'}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 overflow-y-auto p-4">
            {assetCards.map((card) => (
              <div key={card.key} className="rounded-2xl border border-slate-800 bg-[#222329] p-2">
                <div className={`flex aspect-video items-center justify-center rounded-xl ${
                  card.accent === 'cyan' ? 'bg-cyan-400/10 text-cyan-300' : card.accent === 'violet' ? 'bg-violet-500/10 text-violet-300' : card.accent === 'emerald' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300'
                }`}>
                  {activeAssetTab === 'media' ? <ImageIcon className="h-5 w-5" /> : activeAssetTab === 'text' ? <Type className="h-5 w-5" /> : activeAssetTab === 'audio' ? <Music2 className="h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
                </div>
                <div className="mt-2 text-[11px] text-slate-300">{card.title}</div>
                <div className="mt-1 text-[10px] text-slate-500">{card.subtitle}</div>
              </div>
            ))}
            {assetCards.length === 0 ? (
              <div className="col-span-2 rounded-2xl border border-dashed border-slate-800 bg-[#202126] px-4 py-6 text-center text-xs text-slate-500">
                분석된 미디어/장면 카드가 여기에 표시됩니다.
              </div>
            ) : null}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_320px]">
            <div className="min-h-0 border-b border-slate-800 bg-[#18191d]">
              <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_300px]">
                <div className="flex min-h-0 flex-col border-r border-slate-800 bg-[#15161a]">
                  {mode === 'cut' && currentCutItem ? (
                    <div className="border-b border-rose-800/60 bg-rose-950/60 px-4 py-3 text-xs text-rose-100">
                      현재 컷 제안 구간: {(Number(currentCutItem.proposal_start_ms || 0) / 1000).toFixed(1)}s ~ {(Number(currentCutItem.proposal_end_ms || 0) / 1000).toFixed(1)}s
                      {' · '}
                      {currentCutItem.reason_text || '불필요 구간 후보'}
                    </div>
                  ) : null}

                  {mode === 'effect' && currentEffectItem?.proposal?.narration ? (
                    <div className="border-b border-cyan-800/60 bg-cyan-950/50 px-4 py-3 text-xs text-cyan-100">
                      현재 효과 후보: {Number(currentEffectItem.proposal.narration.start_s || 0).toFixed(1)}s ~ {Number(currentEffectItem.proposal.narration.end_s || 0).toFixed(1)}s
                      {' · '}
                      {currentEffectItem.effect?.effect_label || currentEffectItem.proposal.reason || '효과 삽입'}
                    </div>
                  ) : null}

                  {mode === 'steps' && currentStep?.proposal?.narration ? (
                    <div className="border-b border-violet-800/60 bg-violet-950/60 px-4 py-3 text-xs text-violet-100">
                      현재 스텝 구간: {Number(currentStep.proposal.narration.start_s || 0).toFixed(1)}s ~ {Number(currentStep.proposal.narration.end_s || 0).toFixed(1)}s
                      {' · '}
                      {currentStep.proposal.narration.topic || currentStep.proposal.reason || '현재 스텝'}
                    </div>
                  ) : null}

                  <div className="flex min-h-0 flex-1 flex-col">
                    <div className="border-b border-slate-800 px-4 py-3 text-xs text-slate-400">
                      플레이어 · {mode === 'cut' ? '원본 검수' : mode === 'effect' ? '효과 적용 검토' : '편집 미리보기'}
                    </div>
                    <div className="min-h-0 flex-1 bg-[#111214] p-5">
                      {previewUrl ? (
                        <div className="flex h-full w-full flex-col overflow-hidden rounded-[24px] border border-slate-800 bg-black shadow-[0_16px_50px_rgba(0,0,0,0.45)]">
                          <div className="relative min-h-0 flex-1 overflow-hidden bg-black px-4 pt-4 pb-2">
                            <div className="relative h-full w-full overflow-hidden rounded-[18px] bg-black">
                              <video
                                ref={videoRef}
                                key={previewUrl}
                                src={previewUrl}
                                preload="auto"
                                playsInline
                                onPlay={() => setIsPlayingPreview(true)}
                                onPause={() => setIsPlayingPreview(false)}
                                onEnded={() => setIsPlayingPreview(false)}
                                className="absolute inset-0 h-full w-full bg-black object-contain"
                              />
                              {mode === 'cut' && framePreviewUrl && !isPlayingPreview ? (
                                <img
                                  src={framePreviewUrl}
                                  alt="선택 컷 프레임 미리보기"
                                  className="pointer-events-none absolute inset-0 h-full w-full object-contain"
                                />
                              ) : null}
                            </div>
                          </div>
                          <div className="shrink-0 border-t border-slate-800 bg-[#0d0f12] px-4 py-2.5">
                            <div className="flex items-center gap-3">
                              <button
                                type="button"
                                onClick={handleTogglePlayback}
                                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-700 bg-[#1a1d22] text-slate-100 hover:bg-[#232730]"
                              >
                                {isPlayingPreview ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                              </button>
                              <div className="min-w-[96px] text-xs font-medium text-slate-200">
                                {formatPlayerTime(playerCurrentTime)} / {formatPlayerTime(playerDuration)}
                              </div>
                              <input
                                type="range"
                                min={0}
                                max={playerDuration || 0}
                                step={0.1}
                                value={Math.min(playerCurrentTime, playerDuration || 0)}
                                onChange={handleSeekPreview}
                                className="flex-1 accent-cyan-400"
                              />
                              <button
                                type="button"
                                onClick={handleToggleMute}
                                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-700 bg-[#1a1d22] text-slate-300 hover:bg-[#232730]"
                              >
                                {playerMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                              </button>
                              <div className="min-w-[48px] text-right text-xs text-slate-500">
                                {playerDuration > 0 ? `${Math.round(playerProgress)}%` : '--'}
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="flex h-full items-center justify-center rounded-[24px] border border-dashed border-slate-800 bg-[#17181c] text-sm text-slate-500">
                          원본/프리뷰 영상을 준비하는 중입니다.
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex min-h-0 flex-col bg-[#1a1b20]">
                  <div className="border-b border-slate-800 px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-cyan-300">세부 정보</span>
                      <div className="flex items-center gap-2 text-[10px] text-slate-500">
                        <span className="rounded-full bg-[#22242a] px-2 py-1">선택 속성</span>
                        <span className="rounded-full bg-[#22242a] px-2 py-1">메타</span>
                      </div>
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-xs">
                    <div className="rounded-2xl border border-slate-800 bg-[#22242a] p-3">
                      <div className="text-slate-500">현재 모드</div>
                      <div className="mt-1 font-semibold text-slate-100">
                        {mode === 'cut' ? '1단계 · 불필요 구간 편집' : mode === 'effect' ? '2단계 · 효과 삽입' : 'AI 스텝 편집'}
                      </div>
                    </div>
                    <div className="rounded-2xl border border-slate-800 bg-[#22242a] p-3">
                      <div className="text-slate-500">현재 선택</div>
                      <div className="mt-1 font-semibold text-slate-100">
                        {mode === 'cut'
                          ? `${(cutDraftStart / 1000).toFixed(1)}s ~ ${(cutDraftEnd / 1000).toFixed(1)}s`
                          : mode === 'effect'
                            ? (currentEffectItem?.effect?.effect_label || currentEffectItem?.proposal?.reason || '효과 후보 없음')
                          : (currentStep?.proposal?.narration?.topic || '스텝 없음')}
                      </div>
                    </div>
                    <div className="rounded-2xl border border-slate-800 bg-[#22242a] p-3">
                      <div className="text-slate-500">트랙 정보</div>
                      <div className="mt-1 space-y-1 text-[11px] text-slate-300">
                        <div className="flex items-center justify-between">
                          <span>비디오</span>
                          <span>메인 트랙</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>오디오</span>
                          <span>내레이션 기준</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>타임라인</span>
                          <span>{mode === 'cut' ? '컷 검토 중' : mode === 'effect' ? '효과 검토 중' : 'AI 스텝 반영 중'}</span>
                        </div>
                      </div>
                    </div>
                    <div className="rounded-2xl border border-slate-800 bg-[#22242a] p-3">
                      <div className="text-slate-500">출력 설정</div>
                      <div className="mt-1 space-y-1 text-[11px] text-slate-300">
                        <div className="flex items-center justify-between">
                          <span>해상도</span>
                          <span>1920x1080</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>FPS</span>
                          <span>60fps</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>비율</span>
                          <span>16:9</span>
                        </div>
                      </div>
                    </div>
                    {mode === 'cut' && currentCutItem ? (
                      <div className="rounded-2xl border border-rose-500/20 bg-rose-950/30 p-3">
                        <div className="flex items-center justify-between gap-3 text-xs text-slate-300">
                          <span>컷 제안 요약</span>
                          <span>{`${(cutDraftStart / 1000).toFixed(1)}s ~ ${(cutDraftEnd / 1000).toFixed(1)}s`}</span>
                        </div>
                        <div className="mt-3 space-y-2 text-[11px] text-slate-300">
                          <div className="flex items-center justify-between gap-4">
                            <span className="text-slate-500">이유</span>
                            <span className="text-right">{currentCutItem.reason_text || '불필요 구간 후보'}</span>
                          </div>
                          <div className="flex items-center justify-between gap-4">
                            <span className="text-slate-500">confidence</span>
                            <span>{Math.round(Number(currentCutItem.confidence || 0) * 100)}%</span>
                          </div>
                          <div className="flex items-center justify-between gap-4">
                            <span className="text-slate-500">상태</span>
                            <span>{cutDraftStart !== Number(currentCutItem.proposal_start_ms || 0) || cutDraftEnd !== Number(currentCutItem.proposal_end_ms || 0) ? '수정됨' : '원안 유지'}</span>
                          </div>
                        </div>
                        <div className="mt-3 rounded-xl border border-rose-500/10 bg-black/20 px-3 py-2 text-[11px] text-slate-400">
                          실제 구간 조정은 아래 타임라인에서 진행합니다.
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>

            <div className="min-h-0 bg-[#141518] p-4">
              <div className="h-full overflow-hidden rounded-[22px] border border-slate-800 bg-[#1a1b20]">
                <div className="grid grid-cols-3 gap-3 border-b border-slate-800 px-4 py-3 text-xs text-slate-400">
                  <div className="rounded-2xl bg-[#23252b] px-3 py-2">플레이어: {mode === 'cut' ? '원본/제안 검수' : mode === 'effect' ? '효과 포인트 검토' : '프리뷰 우선'}</div>
                  <div className="rounded-2xl bg-[#23252b] px-3 py-2">타임라인: {mode === 'cut' ? '컷 제안 구간 하이라이트' : mode === 'effect' ? '효과 후보 구간 하이라이트' : '현재 스텝 하이라이트'}</div>
                  <div className="rounded-2xl bg-[#23252b] px-3 py-2">컨트롤: 확대/이동/검수</div>
                </div>
                <div className="h-[calc(100%-57px)] p-4">
                  <ErrorBoundary onError={setError}>
                    <LivePlayerProviderComp>
                      <TimelineProviderComp key={timelineKey} initialData={timelineData}>
                        <div ref={editorHostRef} className="timeline-only-host h-full overflow-hidden rounded-[18px] border border-slate-800 bg-[#121317]">
                          <VideoEditorDefault
                            leftPanel={null}
                            rightPanel={null}
                            editorConfig={editorConfig}
                          />
                        </div>
                      </TimelineProviderComp>
                    </LivePlayerProviderComp>
                  </ErrorBoundary>
                </div>
              </div>
            </div>
          </div>
        </div>
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
