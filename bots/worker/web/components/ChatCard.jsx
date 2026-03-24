'use client';

import { useMemo, useRef, useState } from 'react';
import {
  ArrowUpFromLine,
  Check,
  FileText,
  ImagePlus,
  Mic,
  Send,
  Upload,
  Video,
} from 'lucide-react';

function formatBytes(value) {
  const size = Number(value || 0);
  if (!Number.isFinite(size) || size <= 0) return '-';
  const mb = size / (1024 * 1024);
  return `${mb.toFixed(1)}MB`;
}

function FileChip({ file }) {
  const icon = String(file?.type || '').startsWith('audio') ? Mic : Video;
  const Icon = icon;
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5" />
        <span className="truncate font-medium text-slate-800">{String(file?.name || '파일')}</span>
      </div>
      <div className="mt-1">{formatBytes(file?.size)}</div>
    </div>
  );
}

function UploadCard({
  files = [],
  disabled = false,
  onSelectFiles,
}) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  function handleFiles(nextFiles) {
    const items = Array.from(nextFiles || []);
    if (!items.length || disabled) return;
    onSelectFiles?.(items);
    if (inputRef.current) inputRef.current.value = '';
  }

  return (
    <div className="space-y-3">
      <div
        role="button"
        tabIndex={0}
        className={`rounded-3xl border-2 border-dashed px-5 py-8 text-center transition ${
          dragging ? 'border-violet-400 bg-violet-50' : 'border-slate-300 bg-slate-50'
        } ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:border-violet-300 hover:bg-violet-50/70'}`}
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          handleFiles(event.dataTransfer.files);
        }}
      >
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-slate-900 text-white">
          <Upload className="h-6 w-6" />
        </div>
        <p className="mt-4 text-sm font-semibold text-slate-900">원본 영상과 나레이션 파일을 업로드하세요</p>
        <p className="mt-1 text-xs text-slate-500">`.mp4`, `.m4a`, `.mp3`, `.wav` 파일을 드래그하거나 클릭해 선택할 수 있습니다.</p>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => handleFiles(event.target.files)}
      />
      {files.length ? (
        <div className="grid gap-2 md:grid-cols-2">
          {files.map((file, index) => <FileChip key={`${file.name}-${index}`} file={file} />)}
        </div>
      ) : null}
    </div>
  );
}

function AssetModeButton({ active, icon: Icon, title, description, onClick, disabled = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-2xl border px-4 py-3 text-left transition ${
        active
          ? 'border-violet-300 bg-violet-50 text-violet-900'
          : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50'
      } disabled:cursor-not-allowed disabled:opacity-60`}
    >
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4" />
        <span className="text-sm font-semibold">{title}</span>
      </div>
      <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>
    </button>
  );
}

function AssetCard({
  label,
  value,
  disabled = false,
  onSubmit,
}) {
  const [mode, setMode] = useState(value?.mode || 'none');
  const [prompt, setPrompt] = useState(value?.prompt || '');
  const [durationSec, setDurationSec] = useState(value?.durationSec || '');
  const [assetFile, setAssetFile] = useState(null);
  const fileLabel = useMemo(() => {
    if (!assetFile) return '';
    return `${assetFile.name} · ${formatBytes(assetFile.size)}`;
  }, [assetFile]);

  return (
    <div className="space-y-3">
      <div className="grid gap-2">
        <AssetModeButton
          active={mode === 'none'}
          icon={Check}
          title={`${label} 없음`}
          description={`${label} 없이 바로 편집을 진행합니다.`}
          onClick={() => setMode('none')}
          disabled={disabled}
        />
        <AssetModeButton
          active={mode === 'file'}
          icon={ImagePlus}
          title={`${label} 파일 업로드`}
          description={`${label} 영상 또는 이미지를 직접 제공해 고정 삽입합니다.`}
          onClick={() => setMode('file')}
          disabled={disabled}
        />
        <AssetModeButton
          active={mode === 'prompt'}
          icon={FileText}
          title={`${label} 프롬프트 설명`}
          description={`LLM이 ${label} 이미지를 생성하거나 선택할 수 있도록 설명을 남깁니다.`}
          onClick={() => setMode('prompt')}
          disabled={disabled}
        />
      </div>

      {mode === 'file' ? (
        <label className="flex cursor-pointer items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          <span className="truncate">{fileLabel || `${label} 파일 선택`}</span>
          <span className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white">
            <ArrowUpFromLine className="h-3.5 w-3.5" />
            파일 고르기
          </span>
          <input
            type="file"
            hidden
            accept=".mp4,.png,.jpg,.jpeg,.webp"
            onChange={(event) => setAssetFile(event.target.files?.[0] || null)}
          />
        </label>
      ) : null}

      {mode === 'prompt' ? (
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={`${label} 스타일, 브랜드 톤, 텍스트 등을 설명하세요.`}
          rows={4}
          disabled={disabled}
          className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none ring-0 placeholder:text-slate-400"
        />
      ) : null}

      <div className="flex items-center gap-3">
        <input
          value={durationSec}
          onChange={(event) => setDurationSec(event.target.value)}
          placeholder="길이(초)"
          disabled={disabled}
          className="w-28 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none"
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => onSubmit?.({
            mode,
            prompt: prompt.trim(),
            durationSec,
            file: assetFile,
          })}
          className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-300"
        >
          <Check className="h-4 w-4" />
          설정 반영
        </button>
      </div>
    </div>
  );
}

function IntentCard({
  value = '',
  disabled = false,
  onSubmit,
}) {
  const [draft, setDraft] = useState(value);

  return (
    <div className="space-y-3">
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={4}
        disabled={disabled}
        placeholder="예: 자막을 더 크게, 불필요한 무음 구간은 적극 삭제, 화면 전환은 부드럽게"
        className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none placeholder:text-slate-400"
      />
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => onSubmit?.(draft)}
          disabled={disabled || !draft.trim()}
          className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-300"
        >
          <Send className="h-4 w-4" />
          전송
        </button>
      </div>
    </div>
  );
}

function SummaryCard({
  summary,
  disabled = false,
  onStart,
}) {
  return (
    <div className="space-y-4 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-600">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">원본</p>
          <p className="mt-1 font-medium text-slate-900">{summary.videoCount}개 영상 / {summary.audioCount}개 음성</p>
        </div>
        <div className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-600">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">인트로/아웃트로</p>
          <p className="mt-1 font-medium text-slate-900">인트로 {summary.introLabel} / 아웃트로 {summary.outroLabel}</p>
        </div>
      </div>
      <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">편집 의도</p>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{summary.editNotes || '입력 없음'}</p>
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          disabled={disabled}
          onClick={onStart}
          className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-300"
        >
          <Send className="h-4 w-4" />
          편집 시작
        </button>
      </div>
    </div>
  );
}

export default function ChatCard(props) {
  const type = props.type || 'summary';
  if (type === 'upload') {
    return <UploadCard files={props.files} disabled={props.disabled} onSelectFiles={props.onSelectFiles} />;
  }
  if (type === 'intro' || type === 'outro') {
    return (
      <AssetCard
        label={type === 'intro' ? '인트로' : '아웃트로'}
        value={props.value}
        disabled={props.disabled}
        onSubmit={props.onSubmit}
      />
    );
  }
  if (type === 'edit_intent') {
    return <IntentCard value={props.value} disabled={props.disabled} onSubmit={props.onSubmit} />;
  }
  return <SummaryCard summary={props.summary || {}} disabled={props.disabled} onStart={props.onStart} />;
}
