// @ts-nocheck
'use client';

import { useState } from 'react';
import { ArrowUp, Paperclip, Plus } from 'lucide-react';
import { DynamicCanvas } from '@/app/ai/canvas';

function renderInline(text) {
  if (!text) return null;
  const parts = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~)/g;
  let last = 0;
  let match;
  let key = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(<span key={key++}>{text.slice(last, match.index)}</span>);
    const token = match[0];
    if (token.startsWith('`')) parts.push(<code key={key++} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.8em] text-sky-700">{token.slice(1, -1)}</code>);
    else if (token.startsWith('**')) parts.push(<strong key={key++} className="font-semibold text-slate-900">{token.slice(2, -2)}</strong>);
    else if (token.startsWith('*')) parts.push(<em key={key++} className="italic">{token.slice(1, -1)}</em>);
    else if (token.startsWith('~~')) parts.push(<del key={key++} className="text-slate-400 line-through">{token.slice(2, -2)}</del>);
    last = match.index + token.length;
  }
  if (last < text.length) parts.push(<span key={key++}>{text.slice(last)}</span>);
  return parts.length ? parts : text;
}

function InlineMarkdown({ text }) {
  const lines = text.split('\n');
  const result = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      result.push(<div key={`spacer-${index}`} className="h-2" />);
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)/);
    if (heading) {
      const level = heading[1].length;
      const className = level === 1
        ? 'text-base font-bold text-slate-900'
        : level === 2
          ? 'text-sm font-bold text-slate-800'
          : 'text-sm font-semibold text-slate-700';
      result.push(<div key={`heading-${index}`} className={className}>{renderInline(heading[2])}</div>);
      index += 1;
      continue;
    }

    if (/^[\s]*[-*+]\s/.test(line)) {
      const items = [];
      while (index < lines.length && /^[\s]*[-*+]\s/.test(lines[index])) {
        items.push(lines[index].replace(/^[\s]*[-*+]\s/, ''));
        index += 1;
      }
      result.push(
        <ul key={`ul-${index}`} className="space-y-1 pl-4">
          {items.map((item, itemIndex) => (
            <li key={`${item}-${itemIndex}`} className="flex gap-2 text-sm leading-relaxed text-slate-700">
              <span className="mt-0.5 text-slate-400">•</span>
              <span>{renderInline(item)}</span>
            </li>
          ))}
        </ul>
      );
      continue;
    }

    if (/^\d+\.\s/.test(line)) {
      const items = [];
      let number = 1;
      while (index < lines.length && /^\d+\.\s/.test(lines[index])) {
        items.push({ number, text: lines[index].replace(/^\d+\.\s/, '') });
        number += 1;
        index += 1;
      }
      result.push(
        <ol key={`ol-${index}`} className="space-y-1 pl-4">
          {items.map((item) => (
            <li key={`${item.number}-${item.text}`} className="flex gap-2 text-sm leading-relaxed text-slate-700">
              <span className="w-4 flex-shrink-0 text-right text-slate-400">{item.number}.</span>
              <span>{renderInline(item.text)}</span>
            </li>
          ))}
        </ol>
      );
      continue;
    }

    result.push(<p key={`p-${index}`} className="text-sm leading-relaxed text-slate-700">{renderInline(line)}</p>);
    index += 1;
  }

  return <>{result}</>;
}

function MarkdownRenderer({ text }) {
  if (!text) return null;

  const segments = [];
  const codeBlockRe = /```(\w*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'code_block', lang: match[1] || '', content: match[2] });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return (
    <div className="space-y-2">
      {segments.map((segment, segmentIndex) => {
        if (segment.type === 'code_block') {
          return (
            <div key={`code-${segmentIndex}`} className="overflow-hidden rounded-2xl border border-slate-200">
              <div className="border-b border-slate-200 bg-slate-100 px-3 py-1 text-[10px] font-mono text-slate-500">
                {segment.lang || 'text'}
              </div>
              <pre className="overflow-x-auto bg-slate-950 px-4 py-3 text-xs leading-relaxed text-slate-200">
                <code>{segment.content}</code>
              </pre>
            </div>
          );
        }
        return <InlineMarkdown key={`text-${segmentIndex}`} text={segment.content} />;
      })}
    </div>
  );
}

export default function PromptAdvisor({
  title = '프롬프트 어드바이저',
  description,
  badge,
  suggestions = [],
  helperText,
  prompt,
  onPromptChange,
  promptRef,
  placeholder = '메시지 입력',
  onFileClick,
  onFileDrop,
  uploading = false,
  attachedFileName = '',
  onReset,
  showFileButton = true,
  showResetButton = true,
  onSubmit,
  submitDisabled = false,
  error = '',
  notice = '',
  result = null,
  onResultAction,
}) {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = (event) => {
    if (!showFileButton || !onFileDrop) return;
    event.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (event) => {
    if (!showFileButton || !onFileDrop) return;
    event.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (event) => {
    if (!showFileButton || !onFileDrop) return;
    event.preventDefault();
    setIsDragOver(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) onFileDrop(file);
  };

  return (
    <div className="card">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-500">{title}</p>
          {description && <p className="mt-1 text-sm leading-relaxed text-slate-600 break-keep">{description}</p>}
        </div>
        {badge && (
          <span className="max-w-full self-start break-keep rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
            {badge}
          </span>
        )}
      </div>

      {suggestions.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2 overflow-x-auto pb-1 sm:overflow-visible">
          {suggestions.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => onPromptChange?.(item)}
              className="max-w-full rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 break-keep"
            >
              {item}
            </button>
          ))}
        </div>
      )}

      {helperText && <p className="mt-4 text-xs leading-relaxed text-slate-400 break-keep">{helperText}</p>}

      <div className="mt-4 flex flex-col gap-3">
        <div
          className={`relative rounded-[24px] border bg-white px-3 py-3 shadow-[0_18px_40px_-28px_rgba(15,23,42,0.35)] transition sm:rounded-[28px] sm:px-4 sm:py-4 ${
            isDragOver
              ? 'border-sky-300 bg-sky-50/50 ring-2 ring-sky-100'
              : 'border-slate-200'
          }`}
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDragOver && showFileButton && onFileDrop ? (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[24px] sm:rounded-[28px]">
              <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-sky-300 bg-white/95 text-sky-600 shadow-[0_16px_32px_-20px_rgba(2,132,199,0.55)] backdrop-blur-sm">
                <Plus className="h-6 w-6" />
              </div>
            </div>
          ) : null}

          {attachedFileName && (
            <div className="mb-3 flex flex-wrap gap-2">
              <span className="inline-flex max-w-full items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700">
                <Paperclip className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{attachedFileName}</span>
              </span>
            </div>
          )}

          <textarea
            ref={promptRef}
            rows={1}
            className="w-full resize-none overflow-hidden border-0 bg-transparent px-0 py-0 text-sm leading-6 text-slate-900 placeholder:text-slate-400 focus:outline-none"
            value={prompt}
            onChange={(e) => onPromptChange?.(e.target.value)}
            placeholder={placeholder}
          />

          <div className="mt-4 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              {showFileButton && (
                <button
                  type="button"
                  onClick={onFileClick}
                  disabled={uploading}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:bg-slate-100 sm:h-10 sm:w-10"
                  aria-label="파일 추가"
                >
                  <Paperclip className="h-4 w-4" />
                </button>
              )}
              {showResetButton && (
                <button
                  type="button"
                  onClick={onReset}
                  className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-500 transition hover:bg-slate-50"
                >
                  초기화
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={onSubmit}
              disabled={submitDisabled}
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 sm:h-11 sm:w-11"
              aria-label="입력 실행"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      {result && (
        <div className="mt-4 rounded-3xl border border-sky-200 bg-sky-50/70 px-4 py-4 sm:px-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium text-sky-700">어드바이저 결과</p>
              <h3 className="mt-1 text-lg font-semibold text-slate-900">{result.title}</h3>
              {result.summary && <p className="mt-2 text-sm leading-relaxed text-slate-600 break-keep">{result.summary}</p>}
            </div>
            {result.actionLabel && (
              <button
                type="button"
                onClick={onResultAction}
                className="self-start whitespace-nowrap rounded-full border border-sky-200 bg-white px-3 py-1 text-xs font-semibold text-sky-700 hover:bg-sky-100"
              >
                {result.actionLabel}
              </button>
            )}
          </div>

          {result.markdown && (
            <div className="mt-4 space-y-2 text-sm text-slate-600">
              <div className="rounded-2xl bg-white/80 px-4 py-4">
                <MarkdownRenderer text={result.markdown} />
              </div>
            </div>
          )}

          {result.uiComponent && (
            <div className="mt-4 rounded-2xl border border-slate-200 bg-white px-4 py-4">
              <DynamicCanvas component={result.uiComponent} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
