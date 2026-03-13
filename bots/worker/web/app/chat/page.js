'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { api } from '@/lib/api';

const SUGGESTIONS = [
  '오늘 일정 보여줘',
  '내일 오전 10시 김대리 업체 미팅 잡아줘',
  '방금 일정 시간 11시로 변경해줘',
  '방금 일정 취소해줘',
];

function ScheduleCard({ ui }) {
  if (!ui) return null;
  if (ui.type === 'schedule_list') {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">일정 목록</h3>
        <div className="space-y-2">
          {(ui.items || []).map(item => (
            <div key={item.id} className="rounded-xl bg-gray-50 px-3 py-2">
              <p className="text-sm font-medium text-gray-900">{item.title}</p>
              <p className="text-xs text-gray-500">{new Date(item.start_time).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (ui.type === 'schedule') {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3 mb-2">
          <h3 className="text-sm font-semibold text-gray-900">
            {ui.action === 'created' ? '새 일정' : ui.action === 'updated' ? '변경된 일정' : '취소된 일정'}
          </h3>
          <span className="rounded-full bg-indigo-50 px-2 py-1 text-[11px] font-semibold text-indigo-700">
            {ui.schedule?.type || 'task'}
          </span>
        </div>
        <p className="text-base font-semibold text-gray-900">{ui.schedule?.title}</p>
        {ui.schedule?.start_time && (
          <p className="text-sm text-gray-500 mt-1">
            {new Date(ui.schedule.start_time).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}
          </p>
        )}
      </div>
    );
  }

  if (ui.type === 'route') {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-amber-900 mb-1">업무 라우팅</h3>
        <p className="text-sm text-amber-800">{ui.target} 봇으로 분류되었습니다. 자동 실행 연결은 다음 단계에서 확장됩니다.</p>
      </div>
    );
  }

  if (ui.type === 'hint') {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 mb-2">추천 프롬프트</h3>
        <div className="flex flex-wrap gap-2">
          {(ui.suggestions || []).map(s => (
            <span key={s} className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-600">{s}</span>
          ))}
        </div>
      </div>
    );
  }

  return null;
}

export default function WorkerChatPage() {
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [latestUi, setLatestUi] = useState(null);
  const [isPending, startTransition] = useTransition();
  const bottomRef = useRef(null);

  useEffect(() => {
    api.get('/chat/sessions')
      .then(data => {
        setSessions(data.sessions || []);
        if (data.sessions?.[0]?.id) setSessionId(data.sessions[0].id);
      })
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
  }, [messages]);

  async function sendMessage(text) {
    const message = String(text || input).trim();
    if (!message || isPending) return;

    const optimistic = { role: 'user', content: message, createdAt: new Date().toISOString() };
    setMessages(prev => [...prev, optimistic]);
    setInput('');

    startTransition(() => {
      api.post('/chat/send', { message, session_id: sessionId || undefined })
        .then(async data => {
          if (data.sessionId && data.sessionId !== sessionId) {
            setSessionId(data.sessionId);
            const sessionData = await api.get('/chat/sessions').catch(() => null);
            if (sessionData?.sessions) setSessions(sessionData.sessions);
          }
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: data.reply,
            createdAt: new Date().toISOString(),
            intent: data.intent,
            metadata: { ui: data.ui || null },
          }]);
          setLatestUi(data.ui || null);
        })
        .catch(err => {
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: err.message || '요청 처리 중 오류가 발생했습니다.',
            createdAt: new Date().toISOString(),
          }]);
        });
    });
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[320px_minmax(0,1fr)_360px] gap-6">
      <section className="card">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-lg font-bold text-gray-900">AI 업무 대화</h1>
            <p className="text-sm text-gray-500 mt-1">자연어로 일정 등록과 기본 업무 요청을 처리합니다.</p>
          </div>
        </div>
        <div className="space-y-2">
          {sessions.length === 0 ? (
            <div className="rounded-xl bg-gray-50 px-4 py-5 text-sm text-gray-500">
              아직 대화가 없습니다. 오른쪽에서 바로 시작해보세요.
            </div>
          ) : sessions.map(session => (
            <button
              key={session.id}
              onClick={() => setSessionId(session.id)}
              className={`w-full rounded-xl border px-4 py-3 text-left transition-colors ${
                sessionId === session.id ? 'border-indigo-200 bg-indigo-50' : 'border-gray-200 bg-white hover:bg-gray-50'
              }`}
            >
              <p className="text-sm font-semibold text-gray-900">{session.title}</p>
              <p className="text-xs text-gray-500 mt-1">{session.lastAt}</p>
            </button>
          ))}
        </div>
      </section>

      <section className="card min-h-[70vh] flex flex-col">
        <div className="border-b pb-4 mb-4">
          <h2 className="text-base font-semibold text-gray-900">Worker 팀장 대화</h2>
          <p className="text-sm text-gray-500 mt-1">예: "내일 오전 10시 김대리 업체 미팅 잡아줘"</p>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto pr-1">
          {messages.length === 0 ? (
            <div className="rounded-2xl bg-gradient-to-br from-indigo-50 to-sky-50 p-5">
              <p className="text-sm font-semibold text-gray-900 mb-2">바로 시작해보세요</p>
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map(s => (
                  <button
                    key={s}
                    onClick={() => sendMessage(s)}
                    className="rounded-full border border-indigo-200 bg-white px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : messages.map((message, index) => (
            <div key={`${message.createdAt || 'm'}-${index}`} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-2xl px-4 py-3 shadow-sm ${
                message.role === 'user'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-white border border-gray-200 text-gray-900'
              }`}>
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
              </div>
            </div>
          ))}
          {isPending && (
            <div className="flex justify-start">
              <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-500 shadow-sm">
                Worker가 업무를 정리하고 있습니다...
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="border-t pt-4 mt-4">
          <div className="flex gap-3">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              rows={3}
              placeholder="예: 내일 오전 10시 김대리 업체 미팅 잡아줘"
              className="flex-1 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm outline-none ring-0 focus:border-indigo-400"
            />
            <button
              onClick={() => sendMessage()}
              disabled={isPending}
              className="rounded-2xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              전송
            </button>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div className="card">
          <h2 className="text-base font-semibold text-gray-900 mb-2">업무 캔버스</h2>
          <p className="text-sm text-gray-500 mb-4">대화 결과를 카드 형태로 확인하고 다음 액션으로 이어집니다.</p>
          {latestUi ? <ScheduleCard ui={latestUi} /> : (
            <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 px-4 py-8 text-center text-sm text-gray-500">
              아직 표시할 결과가 없습니다.
            </div>
          )}
        </div>
        <div className="card">
          <h2 className="text-base font-semibold text-gray-900 mb-3">지원 범위</h2>
          <ul className="space-y-2 text-sm text-gray-600">
            <li>일정 등록, 조회, 시간 변경, 취소</li>
            <li>문서/인사/급여/매출 요청 1차 분류</li>
            <li>향후 n8n 워크플로우와 승인 체계로 확장 예정</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
