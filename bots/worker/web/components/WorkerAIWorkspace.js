'use client';

import { useEffect, useRef, useState } from 'react';
import { Paperclip, UploadCloud } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { getToken } from '@/lib/auth-context';
import { getMenuPolicy } from '@/lib/menu-access';

const API_BASE = '/api';

function CanvasCard({ ui }) {
  if (!ui) return null;

  if (ui.type === 'schedule_list') {
    return (
      <div className="rounded-[1.25rem] border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-900 mb-3">일정 목록</h3>
        <div className="space-y-2">
          {(ui.items || []).map(item => (
            <div key={item.id} className="rounded-2xl bg-slate-50 px-3 py-2">
              <p className="text-sm font-medium text-slate-900">{item.title}</p>
              <p className="text-xs text-slate-500">
                {new Date(item.start_time).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}
              </p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (ui.type === 'schedule') {
    return (
      <div className="rounded-[1.25rem] border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between gap-3 mb-2">
          <h3 className="text-sm font-semibold text-slate-900">
            {ui.action === 'created' ? '새 일정' : ui.action === 'updated' ? '변경된 일정' : '취소된 일정'}
          </h3>
          <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-700">
            {ui.schedule?.type || 'task'}
          </span>
        </div>
        <p className="text-base font-semibold text-slate-900">{ui.schedule?.title}</p>
        {ui.schedule?.start_time && (
          <p className="text-sm text-slate-500 mt-1">
            {new Date(ui.schedule.start_time).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}
          </p>
        )}
      </div>
    );
  }

  if (ui.type === 'route') {
    return (
      <div className="rounded-[1.25rem] border border-amber-200 bg-amber-50 p-4">
        <h3 className="text-sm font-semibold text-amber-900 mb-1">업무 라우팅</h3>
        <p className="text-sm text-amber-800">
          {ui.target} 봇으로 전달되었습니다. 상태: {ui.status === 'pending_approval' ? '승인 대기' : '처리 대기'}
        </p>
        {ui.task && (
          <div className="mt-3 rounded-2xl bg-white/80 px-3 py-2 text-sm text-amber-950">
            <p className="font-semibold">{ui.task.title}</p>
            <p className="text-xs mt-1">Task #{ui.task.id} · {ui.task.target_bot}</p>
            {ui.task.approval_id && <p className="text-xs mt-1">Approval #{ui.task.approval_id}</p>}
          </div>
        )}
      </div>
    );
  }

  if (ui.type === 'route_result') {
    const okay = ui.status === 'completed';
    return (
      <div className={`rounded-[1.25rem] border p-4 ${okay ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'}`}>
        <h3 className={`text-sm font-semibold mb-1 ${okay ? 'text-emerald-900' : 'text-rose-900'}`}>
          업무 처리 {okay ? '완료' : '실패'}
        </h3>
        <p className={`text-sm ${okay ? 'text-emerald-800' : 'text-rose-800'}`}>
          {ui.target} 봇이 응답했습니다.
        </p>
        <div className="mt-3 rounded-2xl bg-white/80 px-3 py-2 text-sm">
          <p className="font-semibold text-slate-900">{ui.task?.title}</p>
          {ui.summary && <p className="text-xs text-slate-700 mt-1 whitespace-pre-wrap">{ui.summary}</p>}
        </div>
      </div>
    );
  }

  if (ui.type === 'document_upload') {
    return (
      <div className="rounded-[1.25rem] border border-sky-200 bg-sky-50 p-4">
        <h3 className="text-sm font-semibold text-sky-900 mb-1">문서 업로드 완료</h3>
        <p className="text-sm text-sky-800">{ui.filename}</p>
        <div className="mt-3 rounded-2xl bg-white/80 px-3 py-2 text-xs text-slate-700">
          <p>분류: {ui.category || '자동 분류'}</p>
          {ui.summary && <p className="mt-1 whitespace-pre-wrap">{ui.summary}</p>}
        </div>
      </div>
    );
  }

  if (ui.type === 'hint') {
    return (
      <div className="rounded-[1.25rem] border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-900 mb-2">추천 프롬프트</h3>
        <div className="flex flex-wrap gap-2">
          {(ui.suggestions || []).map(s => (
            <span key={s} className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">{s}</span>
          ))}
        </div>
      </div>
    );
  }

  return null;
}

export default function WorkerAIWorkspace({
  menuKey = 'journals',
  title = 'AI 업무 대화',
  description = '자연어로 요청하면 Worker 팀장이 업무를 정리하고 실행으로 연결합니다.',
  suggestions = [],
  allowUpload = true,
  agentName = 'Worker 팀장',
  compact = false,
  showCanvasPanel,
  showQueuePanel,
  showMasterSignalsPanel,
  externalDraft = '',
  draftVersion = 0,
  botOptions = [],
  defaultBotKey = 'worker',
  externalSelectedBot = null,
}) {
  const { user } = useAuth();
  const [agentTasks, setAgentTasks] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [latestUi, setLatestUi] = useState(null);
  const [isPending, setIsPending] = useState(false);
  const [liveStatus, setLiveStatus] = useState('연결 준비 중...');
  const [uploading, setUploading] = useState(false);
  const [selectedBot, setSelectedBot] = useState(defaultBotKey);
  const bottomRef = useRef(null);
  const wsRef = useRef(null);
  const sessionRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const fileRef = useRef(null);
  const textareaRef = useRef(null);
  const aiPolicy = user?.ai_policy || null;
  const menuPolicy = getMenuPolicy(user, menuKey);
  const uiMode = aiPolicy?.ui_mode || 'prompt_only';
  const llmMode = aiPolicy?.llm_mode || 'assist';
  const roleProfile = aiPolicy?.role_profile || (user?.role === 'master' ? 'master' : user?.role === 'admin' ? 'admin' : 'member');
  const promptEnabled = menuPolicy?.prompt_enabled !== false;
  const defaultShowCanvas = uiMode !== 'prompt_only' && menuPolicy?.result_canvas_enabled !== false;
  const showCanvas = typeof showCanvasPanel === 'boolean' ? showCanvasPanel : defaultShowCanvas;
  const showQueue = typeof showQueuePanel === 'boolean' ? showQueuePanel : defaultShowCanvas;
  const showMasterSignals = typeof showMasterSignalsPanel === 'boolean'
    ? showMasterSignalsPanel
    : uiMode === 'full_master_console';
  const uploadEnabled = allowUpload && promptEnabled;
  const promptPlaceholder = llmMode === 'off'
    ? '정형 업무를 자연어로 입력하세요. 예: 오늘 일정 보여줘'
    : '업무를 자연어로 입력하세요';
  const emptyMessage = llmMode === 'off'
    ? '정형 업무 중심으로 빠르게 처리할 수 있습니다. 일정 조회/등록, 직원/매출 요청처럼 명확한 표현을 추천합니다.'
    : '일정, 매출, 인사, 문서 요청을 자연어로 보내면 됩니다.';
  const availableBots = Array.isArray(botOptions) ? botOptions.filter(Boolean) : [];
  const resolvedSelectedBot = availableBots.find((item) => item.key === selectedBot) || availableBots[0] || null;
  const displayAgentName = resolvedSelectedBot?.label || agentName;

  useEffect(() => {
    api.get('/chat/sessions')
      .then(data => {
        if (data.sessions?.[0]?.id) setSessionId(data.sessions[0].id);
      })
      .catch(() => {});
    api.get('/agent-tasks?limit=10')
      .then(data => setAgentTasks(data.tasks || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      return;
    }
    api.get(`/chat/sessions/${sessionId}/messages`)
      .then(data => setMessages(data.messages || []))
      .catch(() => setMessages([]));
  }, [sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isPending]);

  useEffect(() => {
    if (!externalDraft) return;
    setInput(externalDraft);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [externalDraft, draftVersion]);

  useEffect(() => {
    setSelectedBot(defaultBotKey);
  }, [defaultBotKey]);

  useEffect(() => {
    if (!externalSelectedBot) return;
    setSelectedBot(externalSelectedBot);
  }, [externalSelectedBot, draftVersion]);

  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setLiveStatus('로그인 후 실시간 연결');
      return undefined;
    }

    let stopped = false;
    const connect = () => {
      if (stopped) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws/chat?token=${encodeURIComponent(token)}`);
      wsRef.current = socket;

      socket.onopen = () => setLiveStatus('실시간 연결됨');
      socket.onclose = () => {
        if (wsRef.current === socket) wsRef.current = null;
        if (!stopped) {
          setLiveStatus('실시간 연결 끊김 - 재연결 시도 중');
          reconnectTimerRef.current = window.setTimeout(connect, 2000);
        }
      };
      socket.onerror = () => setLiveStatus('실시간 연결 오류 - REST 폴백');
      socket.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'chat.status') {
            setIsPending(true);
            setLiveStatus(data.message || 'Worker가 응답 중입니다...');
            return;
          }
          if (data.type === 'pong' || data.type === 'chat.connected') {
            setLiveStatus('실시간 연결됨');
            if (data.ai_policy?.llm_mode === 'off') {
              setLiveStatus('실시간 연결됨 · LLM 보조 OFF');
            }
            return;
          }
          if (data.type === 'chat.result') {
            setIsPending(false);
            setLiveStatus('실시간 연결됨');
            if (data.sessionId && data.sessionId !== sessionRef.current) setSessionId(data.sessionId);
            setMessages(prev => [...prev, {
              role: 'assistant',
              content: data.reply,
              createdAt: data.ts || new Date().toISOString(),
              intent: data.intent,
              metadata: { ui: data.ui || null },
            }]);
            setLatestUi(data.ui || null);
            const taskData = await api.get('/agent-tasks?limit=10').catch(() => null);
            if (taskData?.tasks) setAgentTasks(taskData.tasks);
            return;
          }
          if (data.type === 'chat.task_result') {
            setLiveStatus('실시간 연결됨');
            const taskData = await api.get('/agent-tasks?limit=10').catch(() => null);
            if (taskData?.tasks) setAgentTasks(taskData.tasks);
            if (data.sessionId && data.sessionId === sessionRef.current) {
              setMessages(prev => [...prev, {
                role: 'assistant',
                content: data.reply,
                createdAt: data.ts || new Date().toISOString(),
                intent: 'task_result',
                metadata: { ui: data.ui || null },
              }]);
              setLatestUi(data.ui || null);
            }
            return;
          }
          if (data.type === 'chat.error') {
            setIsPending(false);
            setMessages(prev => [...prev, {
              role: 'assistant',
              content: data.message || '요청 처리 중 오류가 발생했습니다.',
              createdAt: data.ts || new Date().toISOString(),
            }]);
          }
        } catch {
          /* noop */
        }
      };
    };

    connect();

    const pingTimer = window.setInterval(() => {
      const socket = wsRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
    }, 20000);

    return () => {
      stopped = true;
      window.clearInterval(pingTimer);
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      try { wsRef.current?.close(); } catch {}
    };
  }, []);

  async function refreshTasks() {
    const taskData = await api.get('/agent-tasks?limit=10').catch(() => null);
    if (taskData?.tasks) setAgentTasks(taskData.tasks);
  }

  async function sendMessage(text) {
    const message = String(text || input).trim();
    if (!promptEnabled || !message || isPending) return;

    setMessages(prev => [...prev, {
      role: 'user',
      content: message,
      createdAt: new Date().toISOString(),
    }]);
    setInput('');
    setIsPending(true);

    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'chat.send',
        message,
        sessionId: sessionId || null,
        selectedBot: resolvedSelectedBot?.key || null,
      }));
      return;
    }

    setLiveStatus('REST 폴백 사용 중');
    api.post('/chat/send', {
      message,
      session_id: sessionId || undefined,
      selected_bot: resolvedSelectedBot?.key || undefined,
    })
      .then(async data => {
        setIsPending(false);
        if (data.sessionId && data.sessionId !== sessionId) setSessionId(data.sessionId);
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: data.reply,
          createdAt: new Date().toISOString(),
          intent: data.intent,
          metadata: { ui: data.ui || null },
        }]);
        setLatestUi(data.ui || null);
        await refreshTasks();
      })
      .catch(err => {
        setIsPending(false);
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: err.message || '요청 처리 중 오류가 발생했습니다.',
          createdAt: new Date().toISOString(),
        }]);
      });
  }

  async function handleUpload(event) {
    if (!uploadEnabled) return;
    const file = event.target.files?.[0];
    if (!file) return;
    const token = getToken();
    const formData = new FormData();
    formData.append('file', file);
    setUploading(true);

    try {
      const res = await fetch(`${API_BASE}/documents/upload`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '문서 업로드 실패');
      const ui = {
        type: 'document_upload',
        filename: data.document?.filename || file.name,
        category: data.document?.category || '',
        summary: data.document?.ai_summary || '문서가 업로드되었습니다. 이어서 분석 요청을 보낼 수 있습니다.',
      };
      setLatestUi(ui);
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `문서 업로드가 완료되었습니다. "${file.name}"을 바탕으로 이어서 요청할 수 있습니다.`,
        createdAt: new Date().toISOString(),
        intent: 'document_upload',
        metadata: { ui },
      }]);
    } catch (error) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: error.message || '문서 업로드 중 오류가 발생했습니다.',
        createdAt: new Date().toISOString(),
      }]);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    !promptEnabled ? null :
    <section className={`grid gap-5 ${showCanvas ? 'grid-cols-1 xl:grid-cols-[minmax(0,1.18fr)_minmax(320px,0.82fr)]' : 'grid-cols-1'}`}>
      <div className={`card flex flex-col bg-white/95 backdrop-blur-sm ${compact ? 'min-h-[28rem]' : 'min-h-[36rem]'}`}>
        <div className="border-b border-slate-200 pb-4 mb-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="panel-title">{title}</h2>
              <p className="panel-subtitle mt-1">{description}</p>
              <div className="flex flex-wrap gap-2 mt-3">
                <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold text-slate-600">
                  {roleProfile === 'master' ? '마스터' : roleProfile === 'admin' ? '관리자' : '일반사용자'}
                </span>
                <span className="rounded-full bg-emerald-50 px-3 py-1 text-[11px] font-semibold text-emerald-700 border border-emerald-200">
                  {displayAgentName}
                </span>
                <span className="rounded-full bg-sky-50 px-3 py-1 text-[11px] font-semibold text-sky-700 border border-sky-200">
                  {uiMode === 'prompt_only'
                    ? '프롬프트 전용'
                    : uiMode === 'prompt_plus_dashboard'
                      ? '프롬프트 + 현황'
                      : '마스터 콘솔'}
                </span>
                <span className="rounded-full bg-white px-3 py-1 text-[11px] font-semibold text-slate-700 border border-slate-200">
                  LLM {llmMode === 'off' ? 'OFF' : llmMode === 'full' ? 'FULL' : '보조'}
                </span>
              </div>
            </div>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold text-slate-600">
              {liveStatus}
            </span>
          </div>
          {suggestions.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-4">
              {suggestions.map(item => (
                <button
                  key={item}
                  onClick={() => sendMessage(item)}
                  className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-white"
                >
                  {item}
                </button>
              ))}
            </div>
          )}
          {availableBots.length > 1 && (
            <div className="flex flex-wrap gap-2 mt-4">
              {availableBots.map((bot) => {
                const active = (resolvedSelectedBot?.key || defaultBotKey) === bot.key;
                return (
                  <button
                    key={bot.key}
                    type="button"
                    onClick={() => setSelectedBot(bot.key)}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                      active
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    {bot.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto pr-1">
          {messages.length === 0 ? (
            <div className="rounded-[1.5rem] border border-dashed border-slate-200 bg-gradient-to-br from-white to-slate-50 p-6">
              <p className="text-sm font-semibold text-slate-900 mb-1">대화로 바로 업무를 시작하세요</p>
              <p className="text-sm text-slate-500">{emptyMessage}</p>
            </div>
          ) : messages.map((message, index) => (
            <div key={`${message.createdAt || 'm'}-${index}`} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[82%] rounded-[1.35rem] px-4 py-3 ${
                message.role === 'user'
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-50 border border-slate-200 text-slate-900'
              }`}>
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
              </div>
            </div>
          ))}
          {isPending && (
            <div className="flex justify-start">
              <div className="rounded-[1.35rem] border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
                Worker가 업무를 정리하고 있습니다...
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="border-t border-slate-200 pt-4 mt-4 space-y-3">
          {uploadEnabled && (
            <div className="flex flex-wrap items-center gap-3">
              <input ref={fileRef} type="file" className="hidden" onChange={handleUpload} />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="btn-secondary text-sm gap-2"
              >
                {uploading ? <UploadCloud className="w-4 h-4" /> : <Paperclip className="w-4 h-4" />}
                {uploading ? '업로드 중...' : '파일 업로드'}
              </button>
              <p className="text-xs text-slate-500">문서 관리는 AI 대화에 통합됩니다.</p>
            </div>
          )}
          <div className="flex gap-3">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              rows={3}
              placeholder={promptPlaceholder}
              className="flex-1 rounded-[1.35rem] border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-slate-300"
            />
            <button
              onClick={() => sendMessage()}
              disabled={isPending}
              className="btn-primary px-5 self-end"
            >
              전송
            </button>
          </div>
        </div>
      </div>

      {showCanvas && (
        <div className="space-y-4">
          {showMasterSignals && (
            <div className="card bg-white/95 backdrop-blur-sm">
              <h3 className="panel-title">마스터 신호</h3>
              <p className="panel-subtitle mt-1 mb-4">실시간 연결, 세션, 큐 상태를 한 번에 봅니다.</p>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                  <p className="text-xs text-slate-500">세션</p>
                  <p className="text-lg font-semibold text-slate-900 mt-1">{sessionId ? '연결됨' : '대기'}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                  <p className="text-xs text-slate-500">대기 업무</p>
                  <p className="text-lg font-semibold text-slate-900 mt-1">{agentTasks.length}건</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                  <p className="text-xs text-slate-500">입력 정책</p>
                  <p className="text-lg font-semibold text-slate-900 mt-1">{llmMode === 'full' ? '풀 LLM' : llmMode === 'assist' ? '보조 LLM' : '룰 기반'}</p>
                </div>
              </div>
            </div>
          )}

          <div className="card bg-white/95 backdrop-blur-sm">
            <h3 className="panel-title">업무 캔버스</h3>
            <p className="panel-subtitle mt-1 mb-4">대화 결과와 다음 액션을 카드 형태로 보여줍니다.</p>
            {latestUi ? (
              <CanvasCard ui={latestUi} />
            ) : (
              <div className="rounded-[1.25rem] border border-dashed border-slate-200 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
                아직 표시할 결과가 없습니다.
              </div>
            )}
          </div>

          {showQueue && (
            <div className="card bg-white/95 backdrop-blur-sm">
              <h3 className="panel-title">최근 업무 큐</h3>
              <p className="panel-subtitle mt-1 mb-4">방금 대화로 생성된 업무와 승인 흐름을 확인합니다.</p>
              {agentTasks.length === 0 ? (
                <div className="rounded-[1.25rem] border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                  대기 중인 업무가 없습니다.
                </div>
              ) : (
                <div className="space-y-2">
                  {agentTasks.map(task => (
                    <div key={task.id} className="rounded-2xl border border-slate-200 bg-white px-3 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-semibold text-slate-900">{task.title}</p>
                        <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-700">
                          {task.approval_status === 'pending' ? '승인 대기' : task.status}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 mt-1">{task.target_bot} · 요청자 {task.user_name || task.user_id || '-'}</p>
                      {task.payload?.result_summary && (
                        <p className="text-xs text-emerald-700 mt-1 line-clamp-3">{task.payload.result_summary}</p>
                      )}
                      {task.approval_id && <p className="text-xs text-amber-700 mt-1">Approval #{task.approval_id}</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
