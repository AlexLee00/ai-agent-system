'use client';
import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { api } from '@/lib/api';
import { getToken } from '@/lib/auth-context';
import DataTable from '@/components/DataTable';
import { parseClaudeOutput, DynamicCanvas, CANVAS_LABELS } from './canvas';

// ── 복사 버튼 ─────────────────────────────────────────────────────
function CopyButton({ text, className = '' }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    const str = text || '';
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 2000); };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(str).then(done).catch(() => fallback(str, done));
    } else {
      fallback(str, done);
    }
  };
  const fallback = (str, done) => {
    const el = document.createElement('textarea');
    el.value = str;
    el.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(el);
    el.focus(); el.select();
    try { document.execCommand('copy'); done(); } catch {}
    document.body.removeChild(el);
  };
  return (
    <>
      {copied && (
        <div
          className="fixed bottom-6 left-1/2 z-50 bg-gray-900 text-white text-sm px-4 py-2.5 rounded-xl shadow-xl pointer-events-none"
          style={{ transform: 'translateX(-50%)', animation: 'toastIn .18s ease' }}>
          클립보드에 복사되었습니다.
        </div>
      )}
      <button
        onClick={handleCopy}
        onTouchStart={() => {}}
        title="복사"
        className={`text-gray-400 hover:text-gray-600 active:text-gray-600 touch-manipulation transition-colors ${className}`}>
        {copied
          ? <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          : <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" strokeLinejoin="round" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
        }
      </button>
    </>
  );
}

// ── 마크다운 렌더러 ────────────────────────────────────────────────────
function MarkdownRenderer({ text }) {
  if (!text) return null;

  // 코드 블록 (```lang\n...\n```) 분리 후 처리
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
    <div className="markdown-body space-y-2">
      {segments.map((seg, si) => {
        if (seg.type === 'code_block') {
          return (
            <div key={si} className="rounded-lg overflow-hidden border border-gray-100">
              <div className="flex items-center justify-between px-3 py-1 bg-gray-100 border-b border-gray-100">
                <span className="text-[10px] text-gray-500 font-mono">{seg.lang || ' '}</span>
                <CopyButton text={seg.content} />
              </div>
              <pre className="px-4 py-3 bg-gray-950 text-gray-200 text-xs font-mono overflow-x-auto leading-relaxed">
                <code>{seg.content}</code>
              </pre>
            </div>
          );
        }
        // 인라인 마크다운 처리 (단락/목록/헤더)
        return <InlineMarkdown key={si} text={seg.content} />;
      })}
    </div>
  );
}

function InlineMarkdown({ text }) {
  const lines = text.split('\n');
  const result = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 빈 줄
    if (!line.trim()) { result.push(<div key={i} className="h-2" />); i++; continue; }

    // 헤더
    const hMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (hMatch) {
      const level = hMatch[1].length;
      const cls = level === 1 ? 'text-base font-bold text-gray-900 mt-1'
                : level === 2 ? 'text-sm font-bold text-gray-800 mt-1'
                :               'text-sm font-semibold text-gray-700 mt-0.5';
      result.push(<div key={i} className={cls}>{renderInline(hMatch[2])}</div>);
      i++; continue;
    }

    // 구분선
    if (/^[-*]{3,}$/.test(line.trim())) {
      result.push(<hr key={i} className="border-gray-200 my-2" />);
      i++; continue;
    }

    // 순서 없는 목록 블록
    if (/^[\s]*[-*+]\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^[\s]*[-*+]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[\s]*[-*+]\s/, ''));
        i++;
      }
      result.push(
        <ul key={i} className="space-y-0.5 pl-4">
          {items.map((item, j) => (
            <li key={j} className="flex gap-2 text-sm text-gray-800">
              <span className="text-gray-400 flex-shrink-0 mt-0.5">•</span>
              <span>{renderInline(item)}</span>
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // 순서 있는 목록 블록
    if (/^\d+\.\s/.test(line)) {
      const items = [];
      let num = 1;
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push({ n: num++, text: lines[i].replace(/^\d+\.\s/, '') });
        i++;
      }
      result.push(
        <ol key={i} className="space-y-0.5 pl-4">
          {items.map((item, j) => (
            <li key={j} className="flex gap-2 text-sm text-gray-800">
              <span className="text-gray-400 flex-shrink-0 tabular-nums w-4 text-right">{item.n}.</span>
              <span>{renderInline(item.text)}</span>
            </li>
          ))}
        </ol>
      );
      continue;
    }

    // 일반 문단
    result.push(<p key={i} className="text-sm text-gray-800 leading-relaxed">{renderInline(line)}</p>);
    i++;
  }
  return <>{result}</>;
}

// 인라인 요소: **bold**, *italic*, `code`, ~~strike~~
function renderInline(text) {
  if (!text) return null;
  const parts = [];
  // 순서대로: 코드 → bold → italic → strikethrough
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~)/g;
  let last = 0;
  let m;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(<span key={key++}>{text.slice(last, m.index)}</span>);
    const tok = m[0];
    if (tok.startsWith('`'))   parts.push(<code key={key++} className="bg-gray-100 text-indigo-700 text-[0.8em] px-1 py-0.5 rounded font-mono">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('**')) parts.push(<strong key={key++} className="font-semibold text-gray-900">{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('*'))  parts.push(<em key={key++} className="italic">{tok.slice(1, -1)}</em>);
    else if (tok.startsWith('~~')) parts.push(<del key={key++} className="line-through text-gray-400">{tok.slice(2, -2)}</del>);
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(<span key={key++}>{text.slice(last)}</span>);
  return parts.length ? parts : text;
}

function sanitizeText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function TrendBadge({ trend }) {
  const map = { '상승': 'bg-green-100 text-green-700', '하락': 'bg-red-100 text-red-700', '횡보': 'bg-gray-100 text-gray-600' };
  return <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${map[trend] || 'bg-gray-100 text-gray-600'}`}>{trend}</span>;
}

function ConfidenceBadge({ confidence }) {
  const map = { high: 'bg-green-100 text-green-700', medium: 'bg-yellow-100 text-yellow-700', low: 'bg-red-100 text-red-700' };
  const label = { high: '높음', medium: '보통', low: '낮음' };
  return <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${map[confidence] || 'bg-gray-100 text-gray-600'}`}>{label[confidence] || confidence}</span>;
}

// ── localStorage 헬퍼 ─────────────────────────────────────────────────
const LS_SESSION_KEY   = 'claude_active_session';
const LS_SESSION_INDEX = 'claude_session_index'; // 전체 세션 메타 목록

const lsMsgsKey = (id) => `claude_msgs_${id}`;

function saveMsgs(sessionId, msgs) {
  if (!sessionId) return;
  try { localStorage.setItem(lsMsgsKey(sessionId), JSON.stringify(msgs)); } catch {}
}
function loadMsgs(sessionId) {
  if (!sessionId) return [];
  try { return JSON.parse(localStorage.getItem(lsMsgsKey(sessionId)) || '[]'); } catch { return []; }
}
function saveActiveSession(id) {
  try {
    if (id) localStorage.setItem(LS_SESSION_KEY, id);
    else localStorage.removeItem(LS_SESSION_KEY);
  } catch {}
}
function loadActiveSession() {
  try { return localStorage.getItem(LS_SESSION_KEY); } catch { return null; }
}

// 세션 인덱스 (메타) — 서버 재시작 후에도 목록 유지
function loadSessionIndex() {
  try { return JSON.parse(localStorage.getItem(LS_SESSION_INDEX) || '[]'); } catch { return []; }
}
function saveSessionToIndex(session) {
  if (!session?.id) return;
  try {
    const idx = loadSessionIndex();
    const existing = idx.findIndex(s => s.id === session.id);
    if (existing >= 0) idx[existing] = { ...idx[existing], ...session };
    else idx.unshift(session);
    localStorage.setItem(LS_SESSION_INDEX, JSON.stringify(idx.slice(0, 100)));
  } catch {}
}
function removeSessionFromIndex(id) {
  try {
    const idx = loadSessionIndex().filter(s => s.id !== id);
    localStorage.setItem(LS_SESSION_INDEX, JSON.stringify(idx));
  } catch {}
}

// ── Claude Code 채팅 ──────────────────────────────────────────────────
function ClaudeCodeChat() {
  const [sessions,      setSessions]      = useState([]);
  const [activeSession, setActiveSession] = useState(() => loadActiveSession());
  const [messages,      setMessages]      = useState([]);
  const [inputText,     setInputText]     = useState('');
  const [isSending,     setIsSending]     = useState(false);
  const [error,         setError]         = useState('');
  const [sidebarOpen,   setSidebarOpen]   = useState(false);

  const [attachedFiles,  setAttachedFiles]  = useState([]);  // 첨부 파일 목록
  const [isUploading,    setIsUploading]    = useState(false);
  const [showScrollBtn,  setShowScrollBtn]  = useState(false);

  const chatEndRef            = useRef(null);
  const chatScrollRef         = useRef(null);  // 메시지 스크롤 컨테이너
  const abortRef              = useRef(null);
  const activeSessionRef      = useRef(activeSession);
  const textareaRef           = useRef(null);
  const fileInputRef          = useRef(null);
  const assistantStreamRef    = useRef('');  // 스트리밍 중 assistant 텍스트 누적
  const isSendingRef          = useRef(false); // 중복 전송 방지 + loadMessages 경쟁 조건 방지

  // activeSession 변경 시 ref + localStorage 동기화
  useEffect(() => {
    activeSessionRef.current = activeSession;
    saveActiveSession(activeSession);
  }, [activeSession]);


  // 메시지 변경 시 localStorage에 저장 (캐시 — 세션 클릭 시 즉각 표시용)
  useEffect(() => {
    if (activeSessionRef.current && messages.length > 0) {
      saveMsgs(activeSessionRef.current, messages);
    }
  }, [messages]);

  const prevMsgLenRef = useRef(0);
  const scrollRAFRef  = useRef(null);

  // 새 메시지 추가 시 → paint 전 즉시 보정 (엔터 점프 방지)
  useLayoutEffect(() => {
    if (messages.length === prevMsgLenRef.current) return;
    prevMsgLenRef.current = messages.length;
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // 툴 칩 등 DOM 레이아웃 안정 후 추가 스크롤 (50ms 지연)
  useEffect(() => {
    if (messages.length === 0) return;
    const timer = setTimeout(() => {
      const el = chatScrollRef.current;
      if (!el) return;
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
      if (isNearBottom) el.scrollTop = el.scrollHeight;
    }, 50);
    return () => clearTimeout(timer);
  }, [messages.length]);

  // 스트리밍 중 → RAF 스로틀로 부드럽게 따라가기
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    if (!isNearBottom) return;
    if (scrollRAFRef.current) cancelAnimationFrame(scrollRAFRef.current);
    scrollRAFRef.current = requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }, [messages]);

  // 스크롤 위치 감지 → 하단 이동 버튼 표시
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const onScroll = () => {
      setShowScrollBtn(el.scrollHeight - el.scrollTop - el.clientHeight > 150);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const apiBase = () => `http://${window.location.hostname}:4000`;

  // 메시지 배열에 ui_component 파싱 적용
  function applyParsing(msgs) {
    return msgs.map(m =>
      m.role === 'assistant' && !m.ui_component && m.text
        ? { ...m, ui_component: parseClaudeOutput(m.text) }
        : m
    );
  }

  // 서버에서 메시지 로드 (스트리밍 중엔 덮어쓰지 않음 — 경쟁 조건 방지)
  const loadMessages = useCallback(async (sessionId) => {
    if (!sessionId) { setMessages([]); return; }
    try {
      const res = await fetch(`${apiBase()}/api/claude/sessions/${sessionId}/messages`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const data = await res.json();
      if (Array.isArray(data.messages)) {
        setMessages(prev => isSendingRef.current ? prev : applyParsing(data.messages));
      }
    } catch {}
  }, []);

  const loadSessions = useCallback(async () => {
    // localStorage 구버전 세션 스캔 (인라인 — closure 문제 방지)
    function scanLocalSessions() {
      const map = new Map();
      try {
        // 1) claude_session_index (구버전 세션 인덱스)
        const idx = JSON.parse(localStorage.getItem('claude_session_index') || '[]');
        idx.forEach(s => { if (s?.id) map.set(s.id, s); });
      } catch {}
      try {
        // 2) claude_msgs_* 키 직접 스캔
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key?.startsWith('claude_msgs_')) continue;
          const id = key.replace('claude_msgs_', '');
          if (!id || map.has(id)) continue;
          try {
            const msgs = JSON.parse(localStorage.getItem(key) || '[]');
            if (!msgs.length) continue;
            const firstUser = msgs.find(m => m.role === 'user')?.text || '이전 세션';
            map.set(id, {
              id,
              title: firstUser.length > 50 ? firstUser.slice(0, 50) + '…' : firstUser,
              startedAt: null, lastAt: null, _local: true,
            });
          } catch {}
        }
      } catch {}
      return Array.from(map.values());
    }

    try {
      const res = await fetch(`${apiBase()}/api/claude/sessions`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const data = await res.json();
      const serverSessions = Array.isArray(data.sessions) ? data.sessions : [];
      const serverIds = new Set(serverSessions.map(s => s.id));
      const lsSessions = scanLocalSessions().filter(s => !serverIds.has(s.id));
      setSessions([...serverSessions, ...lsSessions]);
    } catch {
      setSessions(scanLocalSessions());
    }
  }, []);

  // 마운트: 세션 목록 + 이전 활성 세션 메시지 로드
  useEffect(() => {
    loadSessions();
    const sid = loadActiveSession();
    if (sid) loadMessages(sid);
  }, []);

  const handleSend = async (overrideText = null) => {
    const baseText = overrideText !== null ? overrideText : inputText.trim();
    if (!baseText || isSendingRef.current) return;  // ref로 동기 중복 전송 방지

    // 파일 첨부 경로 삽입 (재시도 시엔 파일 미포함)
    const sendFiles = overrideText !== null ? [] : attachedFiles;
    const text = sendFiles.length > 0
      ? `[첨부파일]\n${sendFiles.map(f => `- ${f.path} (${f.name})`).join('\n')}\n\n${baseText}`
      : baseText;

    const now = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: true });
    const userMsg = { role: 'user', text, time: now };
    setMessages(prev => [...prev, userMsg]);
    if (overrideText === null) {
      setInputText('');
      setAttachedFiles([]);
    }
    isSendingRef.current = true;
    setIsSending(true);
    setError('');
    assistantStreamRef.current = ''; // 새 전송 시 누적 초기화

    // XHR 기반 SSE 스트리밍 (모바일 Chrome fetch ReadableStream 버퍼링 우회)
    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        abortRef.current = { abort: () => { xhr.abort(); } };

        let sseBuf = '';
        let consumed = 0;

        function processChunk() {
          const newText = xhr.responseText.slice(consumed);
          consumed = xhr.responseText.length;
          sseBuf += newText;
          const lines = sseBuf.split('\n');
          sseBuf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'event') {
                const ev = data.event;

                if (ev.type === 'system' && ev.session_id) {
                  const sid = ev.session_id;
                  setActiveSession(sid);
                  activeSessionRef.current = sid;
                }

                if (ev.type === 'assistant') {
                  const content = ev.message?.content || [];
                  for (const part of content) {
                    if (part.type === 'text' && part.text) {
                      assistantStreamRef.current += part.text;
                      setMessages(prev => {
                        // 마지막 스트리밍 assistant 찾기 (tool 메시지 사이여도 병합)
                        for (let i = prev.length - 1; i >= 0; i--) {
                          if (prev[i].role === 'assistant' && prev[i].streaming) {
                            const updated = [...prev];
                            updated[i] = { ...prev[i], text: prev[i].text + part.text };
                            return updated;
                          }
                        }
                        return [...prev, { role: 'assistant', text: part.text, streaming: true }];
                      });
                    } else if (part.type === 'tool_use') {
                      setMessages(prev => [...prev, { role: 'tool', name: part.name, input: part.input }]);
                    }
                  }
                }

                if (ev.type === 'result') {
                  const component = parseClaudeOutput(assistantStreamRef.current);
                  const doneTime = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: true });
                  assistantStreamRef.current = '';
                  setMessages(prev => {
                    const idx = [...prev].map((m, i) => ({ m, i })).reverse().find(({ m }) => m.role === 'assistant')?.i ?? -1;
                    if (idx === -1) return prev;
                    const updated = { ...prev[idx], streaming: false, ui_component: component || null, time: doneTime };
                    return [...prev.slice(0, idx), updated, ...prev.slice(idx + 1)];
                  });
                }
              } else if (data.type === 'done') {
                loadSessions().catch(() => {});
              }
            } catch {}
          }
        }

        xhr.open('POST', `${apiBase()}/api/claude/send`, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.setRequestHeader('Authorization', `Bearer ${getToken()}`);

        xhr.onprogress = () => {
          if (xhr.status === 200) processChunk();
        };

        xhr.onload = () => {
          if (xhr.status !== 200) {
            try { reject(new Error(JSON.parse(xhr.responseText).error || '서버 오류')); }
            catch { reject(new Error('서버 오류')); }
            return;
          }
          processChunk(); // 마지막 잔여 데이터 flush
          resolve();
        };

        xhr.onerror = () => reject(new Error('서버 연결 오류'));
        xhr.onabort = () => reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }));

        xhr.send(JSON.stringify({ text, sessionId: activeSessionRef.current }));
      });
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message);
    } finally {
      isSendingRef.current = false;
      setIsSending(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleStop = () => { abortRef.current?.abort(); isSendingRef.current = false; setIsSending(false); };

  const handleNewSession = () => {
    setActiveSession(null);
    setMessages([]);
    setSidebarOpen(false);
    textareaRef.current?.focus();
  };

  const handleSelectSession = (id) => {
    setSidebarOpen(false);
    if (id === activeSession) return;   // 같은 세션 → 닫기만
    setActiveSession(id);
    activeSessionRef.current = id;
    setMessages([]);
    loadMessages(id);
    textareaRef.current?.focus();
  };

  // 캔버스 액션 처리 (form 제출, select 선택, confirm 확인 등)
  const handleCanvasAction = useCallback(({ action, values, label, value, ...rest } = {}) => {
    let text = '';
    if (action === 'form_submit')    text = `다음으로 설정 변경해줘:\n${JSON.stringify(values, null, 2)}`;
    else if (action === 'select')    text = label ? `"${label}" 선택` : String(value || '선택');
    else if (action === 'confirmed') text = rest.confirmLabel || '확인, 진행해줘';
    else if (action === 'cancelled') text = '취소';
    if (text) {
      setInputText(text);
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, []);

  const handleDeleteSession = async (id, e) => {
    e.stopPropagation();
    setSidebarOpen(false);
    // 즉시 UI 업데이트 (re-scan 방지)
    setSessions(prev => prev.filter(s => s.id !== id));
    if (activeSession === id) { setActiveSession(null); setMessages([]); }
    // localStorage 정리
    try { localStorage.removeItem(lsMsgsKey(id)); } catch {}
    try { removeSessionFromIndex(id); } catch {}
    // 서버 삭제 (백그라운드)
    try {
      await fetch(`${apiBase()}/api/claude/sessions/${id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${getToken()}` },
      });
    } catch {}
  };

  const handleFileAttach = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    setIsUploading(true);
    for (const file of files) {
      const formData = new FormData();
      formData.append('file', file);
      try {
        const res = await fetch(`${apiBase()}/api/claude/upload`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${getToken()}` },
          body: formData,
        });
        const data = await res.json();
        if (data.ok) setAttachedFiles(prev => [...prev, { name: data.name, path: data.path }]);
      } catch {}
    }
    setIsUploading(false);
    e.target.value = '';
  };

  const handleRegenerate = () => {
    if (isSending) return;
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx === -1) return;
    const lastUserText = messages[lastUserIdx].text;
    setMessages(prev => prev.slice(0, lastUserIdx)); // 마지막 유저 메시지 포함 이후 전부 제거
    handleSend(lastUserText);
  };

  const currentTitle = sessions.find(s => s.id === activeSession)?.title || null;

  // ── 세션 목록 (JSX 변수 — 컴포넌트 아님, remount 방지) ──────────────
  const sidebarContent = (
    <>
      <button
        onClick={handleNewSession}
        className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm font-medium touch-manipulation
          bg-primary text-white active:opacity-80 transition-opacity duration-100 mb-2">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
        </svg>
        새 채팅
      </button>

      {sessions.length === 0 ? (
        <p className="text-xs text-gray-400 text-center mt-6">세션 없음</p>
      ) : (
        <div className="space-y-0.5 overflow-y-auto overscroll-contain flex-1 min-h-0">
          <p className="text-xs text-gray-400 px-2 py-1 uppercase tracking-wider font-semibold">최근 채팅</p>
          {sessions.map(s => (
            <div key={s.id} className="flex items-center gap-1">
              <button
                type="button"
                onTouchStart={() => {}}
                onClick={() => handleSelectSession(s.id)}
                className={`flex-1 flex items-start gap-1 px-3 py-2 rounded-lg text-left transition-colors duration-100 touch-manipulation active:opacity-70 ${
                  activeSession === s.id
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-gray-600'
                }`}>
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate leading-snug">{s.title || '새 세션'}</p>
                  {s.lastAt && (
                    <p className="text-[11px] text-gray-400 mt-0.5">{s.lastAt.slice(5, 16)}</p>
                  )}
                </div>
              </button>
              <button
                type="button"
                onTouchStart={() => {}}
                onClick={(e) => handleDeleteSession(s.id, e)}
                className="flex-shrink-0 text-gray-300 active:text-red-400 p-1.5 rounded touch-manipulation">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );

  return (
    <div
      className="flex gap-0 overflow-hidden rounded-[28px] border border-slate-200/80 bg-white shadow-[0_20px_60px_-32px_rgba(15,23,42,0.28)]"
      style={{ height: 'calc(100vh - 240px)', minHeight: '560px' }}>


      {/* ── 데스크탑 사이드바 ── */}
      <div className="hidden w-56 flex-shrink-0 flex-col gap-1 border-r border-slate-200/80 bg-slate-50/90 p-3 md:flex">
        <div className="mb-1 flex items-center gap-2 px-1 py-2">
          <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-slate-900">
            <svg className="w-3.5 h-3.5 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/>
            </svg>
          </div>
          <span className="text-sm font-semibold tracking-tight text-slate-800">Claude Code</span>
        </div>
        {sidebarContent}
      </div>

      {/* ── 모바일 오버레이 드로어 ── */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          {/* 드로어 패널 — 백드롭과 나란히 배치해 터치 가로채기 방지 */}
          <div className="w-72 flex flex-col p-4 gap-1 shadow-xl bg-white h-full">
            <div className="flex items-center justify-between mb-2 flex-shrink-0">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center">
                  <svg className="w-3.5 h-3.5 text-white" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/>
                  </svg>
                </div>
                <span className="text-gray-800 font-semibold text-sm">Claude Code</span>
              </div>
              <button onClick={() => setSidebarOpen(false)}
                className="text-gray-400 hover:text-gray-600 p-1 rounded transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {sidebarContent}
          </div>
          {/* 백드롭 — 드로어 오른쪽 영역만 커버 */}
          <div className="flex-1 bg-black/30" onClick={() => setSidebarOpen(false)} />
        </div>
      )}

      {/* ── 채팅 영역 ── */}
      <div className="flex min-w-0 flex-1 flex-col bg-white">

        {/* 헤더 */}
        <div className="flex flex-shrink-0 items-center gap-3 border-b border-slate-200/80 bg-white px-5 py-4">
          {/* 모바일: 햄버거 */}
          <button
            className="md:hidden p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
            onClick={() => setSidebarOpen(true)}>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          <div className="flex-1 min-w-0">
            <p className="truncate text-sm font-semibold text-slate-800">
              {currentTitle || (activeSession ? 'Claude Code' : '새 채팅')}
            </p>
            {activeSession && (
              <p className="mt-px font-mono text-[11px] text-slate-400">{activeSession.slice(0, 12)}…</p>
            )}
          </div>

          <div className="flex items-center gap-1.5 flex-shrink-0">
            <span className="hidden items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-600 sm:flex">
              <span className="w-1.5 h-1.5 bg-green-400 rounded-full inline-block"></span>
              claude-code
            </span>
          </div>
        </div>

        {/* 메시지 목록 */}
        <div className="flex-1 relative min-h-0">
        {showScrollBtn && (
          <button
            onTouchStart={() => {}}
            onClick={() => { const el = chatScrollRef.current; if (el) el.scrollTop = el.scrollHeight; }}
            className="absolute bottom-3 left-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-200 rounded-full shadow-md text-xs text-gray-600 hover:bg-gray-50 active:bg-gray-100 touch-manipulation transition-colors"
            style={{ transform: 'translateX(-50%)' }}>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
            아래로
          </button>
        )}
        <div ref={chatScrollRef} className="h-full overflow-y-auto overscroll-contain bg-slate-50/70" style={{ touchAction: 'pan-y' }}>
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center px-6 py-12">
              <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-[22px] bg-slate-900 shadow-lg">
                <svg className="w-8 h-8 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/>
                </svg>
              </div>
              <h3 className="mb-1 text-lg font-semibold text-slate-800">Claude Code</h3>
              <p className="max-w-xs text-center text-sm text-slate-500">
                코드 작성, 버그 수정, 파일 편집, 시스템 분석 등 무엇이든 물어보세요
              </p>
              <div className="mt-6 flex flex-wrap gap-2 justify-center">
                {['코드 리뷰해줘', '버그 찾아줘', '파일 목록 보여줘', '시스템 상태 확인'].map(q => (
                  <button key={q}
                    onClick={() => { setInputText(q); textareaRef.current?.focus(); }}
                    className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 shadow-sm transition-colors hover:border-slate-300 hover:text-slate-900">
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-4 px-4 py-5">
              {(() => {
                // 연속된 tool 메시지 그룹핑
                const groups = [];
                let i = 0;
                while (i < messages.length) {
                  if (messages[i].role === 'tool') {
                    const startIdx = i;
                    const tools = [];
                    while (i < messages.length && messages[i].role === 'tool') tools.push(messages[i++]);
                    groups.push({ type: 'tools', tools, key: `t${startIdx}` });
                  } else {
                    groups.push({ type: 'msg', msg: messages[i], key: i });
                    i++;
                  }
                }
                // 마지막 assistant 그룹 인덱스 (재시도 버튼 표시용)
                let lastAssistantIdx = -1;
                for (let j = groups.length - 1; j >= 0; j--) {
                  if (groups[j].type === 'msg' && groups[j].msg.role === 'assistant') { lastAssistantIdx = j; break; }
                }
                return groups.map((g, gi) => {
                  if (g.type === 'tools') {
                    const isActive = isSending && gi === groups.length - 1;
                    return (
                    <div key={g.key} className="pl-9">
                      {/* 1단계: 전체 그룹 */}
                      <details className="group/outer w-fit max-w-[90%]">
                        <summary className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full cursor-pointer text-[11px] font-medium select-none transition-colors list-none ${
                          isActive ? 'bg-blue-50 text-blue-600 hover:bg-blue-100' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                        }`}>
                          {isActive ? (
                            <svg className="w-3 h-3 text-blue-400 flex-shrink-0 animate-spin" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                              <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                            </svg>
                          ) : (
                            <svg className="w-3 h-3 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3" />
                            </svg>
                          )}
                          {g.tools.length === 1 ? g.tools[0].name : `${g.tools.length}개 작업 수행`}
                          <svg className={`w-2.5 h-2.5 group-open/outer:rotate-180 transition-transform ${isActive ? 'text-blue-300' : 'text-gray-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                          </svg>
                        </summary>
                        {/* 2단계: 개별 tool */}
                        <div className="mt-1.5 ml-2 flex flex-col gap-0.5 bg-gray-50 border border-gray-100 rounded-xl px-2 py-1.5">
                          {g.tools.map((t, ti) => (
                            <details key={ti} className="group/inner">
                              <summary className="flex items-center gap-1.5 px-1.5 py-0.5 rounded-md hover:bg-gray-100 cursor-pointer text-[11px] text-gray-400 select-none transition-colors list-none">
                                <span className={`w-1 h-1 rounded-full flex-shrink-0 ${isActive && ti === g.tools.length - 1 ? 'bg-blue-400 animate-pulse' : 'bg-gray-300'}`} />
                                {t.name}
                                <svg className="w-2 h-2 text-gray-300 group-open/inner:rotate-180 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                                </svg>
                              </summary>
                              <pre className="mt-1 mx-1 text-[10px] text-gray-500 bg-white rounded-lg px-3 py-2 overflow-x-auto max-h-36 font-mono leading-relaxed border border-gray-100">
                                {JSON.stringify(t.input, null, 2)}
                              </pre>
                            </details>
                          ))}
                        </div>
                      </details>
                    </div>
                  );};

                  const msg = g.msg;
                  if (msg.role === 'user') return (
                    <div key={g.key} className="flex justify-end">
                      <div className="max-w-[80%] sm:max-w-lg">
                        <div className="bg-indigo-600 text-white rounded-2xl rounded-br-md px-4 py-2.5 text-sm whitespace-pre-wrap break-words leading-relaxed">
                          {msg.text}
                        </div>
                        <div className="flex items-center justify-end gap-2 mt-0.5 pr-0.5">
                          {msg.time && <span className="text-xs text-gray-400">{msg.time}</span>}
                          <CopyButton text={msg.text} />
                        </div>
                      </div>
                    </div>
                  );

                return (
                  <div key={g.key} className="flex flex-col gap-2">
                    <div className="flex justify-start gap-3">
                      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center flex-shrink-0 mt-0.5 shadow-sm">
                        <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/>
                        </svg>
                      </div>
                      <div className="max-w-[85%] sm:max-w-xl">
                        <div
                          className="bg-white border border-gray-100 rounded-2xl rounded-tl-md px-4 py-2.5 shadow-sm relative">
                          {msg.streaming
                            ? <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">{msg.text}</p>
                            : <MarkdownRenderer text={msg.text} />
                          }
                          {msg.streaming && (
                            <span className="inline-flex items-center gap-[3px] ml-1.5 align-middle" style={{ height: '14px' }}>
                              {[0, 0.18, 0.36, 0.18].map((d, i) => (
                                <span key={i} className="w-[3px] h-3 bg-primary rounded-full origin-center"
                                  style={{ animation: `thinking 1s ease-in-out infinite`, animationDelay: `${d}s` }} />
                              ))}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    {/* 인라인 캔버스 */}
                    {msg.ui_component && !msg.streaming && (
                      <div className="ml-10 border border-gray-100 rounded-xl p-3 bg-white shadow-sm">
                        <p className="text-[10px] text-gray-400 font-medium mb-2 uppercase tracking-wider">
                          {CANVAS_LABELS[msg.ui_component.type] || '캔버스'}
                        </p>
                        <DynamicCanvas component={msg.ui_component} onAction={handleCanvasAction} />
                      </div>
                    )}
                    {!msg.streaming && (
                      <div className="flex items-center gap-3 ml-10 mt-0.5">
                        {msg.time && <span className="text-xs text-gray-400">{msg.time}</span>}
                        <CopyButton text={msg.text} />
                        {gi === lastAssistantIdx && (
                          <button
                            onTouchStart={() => {}}
                            onClick={handleRegenerate}
                            className="text-xs text-gray-400 hover:text-gray-600 active:text-gray-600 touch-manipulation transition-colors">
                            ↺ 재시도
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
                return null;
              });
              })()}
              <div ref={chatEndRef} />
            </div>
          )}
        </div>
        </div>

        {error && (
          <div className="px-4 py-2 flex items-center gap-2 text-xs text-red-600 bg-red-50 border-t border-red-100 flex-shrink-0">
            <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {error}
          </div>
        )}

        {/* 입력 영역 */}
        <div className="flex-shrink-0 border-t border-slate-200/80 bg-white px-4 py-3">
          {/* 첨부 파일 칩 */}
          {attachedFiles.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {attachedFiles.map((f, i) => (
                <span key={i} className="flex items-center gap-1 text-[11px] bg-indigo-50 text-indigo-700 border border-indigo-100 rounded-full px-2 py-0.5 max-w-[180px]">
                  <span className="truncate">📎 {f.name}</span>
                  <button
                    onClick={() => setAttachedFiles(prev => prev.filter((_, j) => j !== i))}
                    className="text-indigo-400 hover:text-indigo-600 flex-shrink-0 ml-0.5 leading-none">×</button>
                </span>
              ))}
            </div>
          )}
          <input type="file" ref={fileInputRef} multiple className="hidden" onChange={handleFileAttach} />
          <div className={`flex items-end gap-2 bg-gray-50 border rounded-2xl px-3 py-2 transition-colors ${
            isSending ? 'border-orange-200 bg-orange-50/30' : 'border-gray-200 focus-within:border-gray-300 focus-within:bg-white'
          }`}>
            {/* 파일 첨부 버튼 */}
            <button
              type="button"
              onTouchStart={() => {}}
              onClick={() => fileInputRef.current?.click()}
              disabled={isSending || isUploading}
              className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 active:text-gray-600 touch-manipulation transition-colors disabled:opacity-30 mb-0.5">
              {isUploading
                ? <span className="w-3.5 h-3.5 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin" />
                : <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
              }
            </button>
            <textarea
              ref={textareaRef}
              className="flex-1 resize-none bg-transparent text-sm text-gray-800 placeholder-gray-400 outline-none max-h-36 py-2 leading-normal"
              rows={1}
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="메시지 입력… (Shift+Enter 줄바꿈)"
              disabled={isSending}
              style={{ fieldSizing: 'content' }}
            />
            {isSending ? (
              <button
                onClick={handleStop}
                className="flex-shrink-0 w-8 h-8 rounded-lg bg-red-100 text-red-500 hover:bg-red-200 flex items-center justify-center transition-colors">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <rect x="6" y="6" width="12" height="12" rx="2"/>
                </svg>
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!inputText.trim()}
                className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed bg-indigo-600 hover:bg-indigo-700 text-white">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

    </div>
  );
}

// ── 메인 페이지 ───────────────────────────────────────────────────────
export default function AIPage() {
  const [activeTab, setActiveTab] = useState('ai');
  // SSR 이후 클라이언트에서 저장된 탭 복원 (localStorage는 서버에서 미지원)
  useEffect(() => {
    try {
      const saved = localStorage.getItem('worker_ai_tab');
      if (saved) setActiveTab(saved);
    } catch {}
  }, []);

  const [question,  setQuestion]  = useState('');
  const [asking,    setAsking]    = useState(false);
  const [askResult, setAskResult] = useState(null);
  const [askError,  setAskError]  = useState('');

  const [forecasting, setForecasting] = useState(false);
  const [forecast,    setForecast]    = useState(null);
  const [fcError,     setFcError]     = useState('');

  const handleAsk = async (e) => {
    e.preventDefault();
    if (!question.trim()) return;
    setAsking(true); setAskError(''); setAskResult(null);
    try { setAskResult(await api.post('/ai/ask', { question })); }
    catch (e) { setAskError(e.message); }
    finally { setAsking(false); }
  };

  const handleForecast = async () => {
    setForecasting(true); setFcError(''); setForecast(null);
    try { setForecast(await api.post('/ai/revenue-forecast', {})); }
    catch (e) { setFcError(e.message); }
    finally { setForecasting(false); }
  };

  const dataColumns = askResult?.data?.length > 0
    ? Object.keys(askResult.data[0]).map(k => ({ key: k, label: k }))
    : [];

  return (
    <div className="max-w-7xl space-y-6">
      <section className="overflow-hidden rounded-[28px] border border-slate-200/80 bg-[radial-gradient(circle_at_top_left,_rgba(148,163,184,0.18),_transparent_36%),linear-gradient(180deg,_#ffffff_0%,_#f8fafc_100%)] p-6 shadow-[0_18px_60px_-34px_rgba(15,23,42,0.35)]">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl space-y-3">
            <div className="inline-flex items-center rounded-full border border-slate-200 bg-white/90 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">
              Admin Intelligence
            </div>
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
                AI 분석과 Claude Code를 한 화면에서 운영합니다
              </h1>
              <p className="max-w-2xl text-sm leading-6 text-slate-600 sm:text-[15px]">
                운영 데이터를 자연어로 질의하고, 예측을 확인하고, 필요하면 Claude Code와 바로 이어서 점검할 수 있는 관리자 분석 허브입니다.
              </p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3 lg:min-w-[340px]">
            {[
              { label: '분석 모드', value: activeTab === 'ai' ? '활성' : '대기', tone: 'text-slate-900' },
              { label: 'Claude Code', value: activeTab === 'claude' ? '연결됨' : '준비됨', tone: 'text-slate-900' },
              { label: '데이터 흐름', value: '실시간', tone: 'text-emerald-700' },
            ].map((item) => (
              <div key={item.label} className="rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 shadow-sm">
                <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-400">{item.label}</p>
                <p className={`mt-2 text-sm font-semibold ${item.tone}`}>{item.value}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="inline-flex rounded-2xl border border-slate-200 bg-slate-100/80 p-1">
        {[{ id: 'ai', label: 'AI 분석' }, { id: 'claude', label: 'Claude Code' }].map((t) => (
          <button
            key={t.id}
            onClick={() => { setActiveTab(t.id); try { localStorage.setItem('worker_ai_tab', t.id); } catch {} }}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition-all ${
              activeTab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'ai' && (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
          <div className="space-y-6">
            <div className="rounded-[26px] border border-slate-200 bg-white p-6 shadow-[0_18px_50px_-34px_rgba(15,23,42,0.3)]">
              <div className="mb-5 flex flex-col gap-2">
                <h2 className="text-lg font-semibold text-slate-900">자연어 질문</h2>
                <p className="text-sm leading-6 text-slate-500">업무 데이터를 그대로 물어보면 SQL과 답변이 함께 정리됩니다.</p>
              </div>
              <form onSubmit={handleAsk} className="flex gap-2">
                <input className="input-base flex-1" value={question} onChange={e => setQuestion(e.target.value)}
                  placeholder="예: 이번 달 매출 합계는?" disabled={asking} />
                <button className="btn-primary px-5" type="submit" disabled={asking || !question.trim()}>
                  {asking ? '분석 중...' : '질문'}
                </button>
              </form>
              <div className="mt-4 flex flex-wrap gap-2">
                {['이번 달 매출 합계는?', '지각 횟수가 가장 많은 직원은?', '완료되지 않은 프로젝트 목록', '3월 급여 총액은 얼마인가요?'].map(q => (
                  <button key={q} onClick={() => setQuestion(q)}
                    className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600 transition-colors hover:border-slate-300 hover:bg-white hover:text-slate-900">{q}</button>
                ))}
              </div>
              {askError && <p className="mt-4 text-sm text-red-500">{askError}</p>}
              {askResult && (
                <div className="mt-5 space-y-3">
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <p className="whitespace-pre-wrap text-sm font-medium leading-6 text-slate-800">{sanitizeText(askResult.answer)}</p>
                  </div>
                  <div className="flex gap-3 text-xs text-slate-400">
                    <span>조회 {askResult.rowCount}건</span>
                    {askResult.ragUsed && <span className="text-sky-600">RAG 문서 참조</span>}
                  </div>
                  {askResult.data?.length > 0 && (
                    <div>
                      <p className="mb-2 text-xs font-medium text-slate-500">원본 데이터 (최대 50건)</p>
                      <div className="overflow-x-auto"><DataTable columns={dataColumns} data={askResult.data} emptyText="데이터 없음" /></div>
                    </div>
                  )}
                  <details className="text-xs">
                    <summary className="cursor-pointer text-slate-400 hover:text-slate-700">실행된 SQL 보기</summary>
                    <pre className="mt-2 overflow-x-auto rounded-2xl bg-slate-950 p-3 text-xs text-slate-100">{askResult.sql}</pre>
                  </details>
                </div>
              )}
            </div>

            <div className="rounded-[26px] border border-slate-200 bg-white p-6 shadow-[0_18px_50px_-34px_rgba(15,23,42,0.3)]">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">매출 AI 예측</h2>
                  <p className="mt-1 text-sm text-slate-500">최근 90일 매출 데이터 기반 30일 예측</p>
                </div>
                <button className="btn-primary text-sm" onClick={handleForecast} disabled={forecasting}>
                  {forecasting ? '예측 중...' : '예측 실행'}
                </button>
              </div>
              {fcError && <p className="mt-4 text-sm text-red-500">{fcError}</p>}
              {forecast && (
                <div className="mt-5">
                  {forecast.message ? (
                    <p className="rounded-2xl bg-amber-50 p-3 text-sm text-amber-600">{forecast.message}</p>
                  ) : forecast.forecast && (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <div className="rounded-2xl bg-slate-50 p-3 text-center"><p className="mb-1 text-xs text-slate-500">트렌드</p><TrendBadge trend={forecast.forecast.trend} /></div>
                        <div className="rounded-2xl bg-slate-50 p-3 text-center"><p className="mb-1 text-xs text-slate-500">신뢰도</p><ConfidenceBadge confidence={forecast.forecast.confidence} /></div>
                        <div className="col-span-2 rounded-2xl border border-slate-200 bg-slate-900 p-3 text-center">
                          <p className="mb-1 text-xs text-slate-400">30일 예상 매출</p>
                          <p className="font-bold text-white">₩{Number(forecast.forecast.forecast_30d_total || 0).toLocaleString()}</p>
                          <p className="text-xs text-slate-400">일평균 ₩{Number(forecast.forecast.forecast_30d_daily_avg || 0).toLocaleString()}</p>
                        </div>
                      </div>
                      <div className="space-y-2 rounded-2xl bg-slate-50 p-4 text-sm">
                        <p className="text-slate-700">{sanitizeText(forecast.forecast.analysis)}</p>
                        {forecast.forecast.weekly_pattern && <p className="text-xs text-slate-500">{sanitizeText(forecast.forecast.weekly_pattern)}</p>}
                        {forecast.forecast.warnings && <p className="text-xs text-amber-600">{sanitizeText(forecast.forecast.warnings)}</p>}
                      </div>
                      <p className="text-xs text-slate-400">분석 기간: {forecast.period?.from} ~ {forecast.period?.to} ({forecast.dataPoints}일)</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <aside className="space-y-6">
            <div className="rounded-[26px] border border-slate-200 bg-white p-6 shadow-[0_18px_50px_-34px_rgba(15,23,42,0.28)]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">Analysis Guide</p>
              <div className="mt-4 space-y-4">
                {[
                  {
                    title: '자연어 질의',
                    body: '매출, 근태, 프로젝트, 급여 데이터를 사람 말투 그대로 질문하면 SQL과 함께 정리합니다.',
                  },
                  {
                    title: '예측',
                    body: '최근 90일 흐름을 바탕으로 30일 매출을 빠르게 확인할 수 있습니다.',
                  },
                  {
                    title: 'Claude Code',
                    body: '운영 이슈나 코드 점검이 필요하면 바로 옆 탭으로 넘어가 세션 단위로 이어서 작업할 수 있습니다.',
                  },
                ].map((item) => (
                  <div key={item.title} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <h3 className="text-sm font-semibold text-slate-900">{item.title}</h3>
                    <p className="mt-1 text-sm leading-6 text-slate-500">{item.body}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-[26px] border border-slate-200 bg-slate-900 p-6 text-white shadow-[0_18px_50px_-34px_rgba(15,23,42,0.45)]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">Recommended Prompts</p>
              <div className="mt-4 space-y-2">
                {[
                  '이번 주 근태 이상 징후를 요약해줘',
                  '이번 달 부서별 매출 비교표를 보여줘',
                  '지연 중인 프로젝트와 담당자를 정리해줘',
                  '승인 대기 중인 업무가 얼마나 있는지 알려줘',
                ].map((prompt) => (
                  <button
                    key={prompt}
                    onClick={() => setQuestion(prompt)}
                    className="w-full rounded-2xl border border-slate-700 bg-slate-800 px-4 py-3 text-left text-sm text-slate-100 transition-colors hover:border-slate-500 hover:bg-slate-700">
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          </aside>
        </div>
      )}

      {activeTab === 'claude' && <ClaudeCodeChat />}
    </div>
  );
}
