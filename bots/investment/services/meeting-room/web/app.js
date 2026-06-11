const html = htm.bind(React.createElement);
const { useEffect, useMemo, useState } = React;

function useToken() {
  const [token, setToken] = useState(() => localStorage.getItem('lunaMeetingRoomToken') || '');
  function update(value) {
    setToken(value);
    localStorage.setItem('lunaMeetingRoomToken', value);
  }
  return [token, update];
}

function formatTime(value) {
  if (!value) return 'n/a';
  try {
    return new Date(value).toLocaleString('ko-KR', { hour12: false });
  } catch {
    return String(value);
  }
}

function api(token, path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.body && !headers['content-type']) headers['content-type'] = 'application/json';
  return fetch(path, { ...options, headers }).then(async (res) => {
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(payload.message || payload.error || `HTTP ${res.status}`);
      error.status = res.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  });
}

function roleName(role) {
  return { data: '데이터', analysis: '분석', grill: '그릴', decision: '결정', system: '시스템' }[role] || role;
}

function meetingTypesForSegments(segments = []) {
  const domestic = segments.find((row) => row.market === 'domestic');
  const overseas = segments.find((row) => row.market === 'overseas');
  return [
    { value: 'morning', label: '아침 통합 회의', disabled: false },
    { value: 'domestic_debrief', label: `국내 장후 회의${domestic?.skipped ? ` (${domestic.reason})` : ''}`, disabled: domestic?.skipped === true },
    { value: 'us_premarket', label: `미장 전 회의${overseas?.skipped ? ` (${overseas.reason})` : ''}`, disabled: overseas?.skipped === true },
    { value: 'weekly', label: '주간 회의', disabled: false },
    { value: 'adhoc', label: '임시 회의', disabled: false },
  ];
}

function Header({ token, setToken, tab, setTab }) {
  return html`
    <div className="hero">
      <div>
        <div className="topline">
          <span className="pill">MR-B</span>
          <span className="pill">advisory / shadow only</span>
          <span className="pill">127.0.0.1:7791</span>
        </div>
        <h1>Luna Meeting Room</h1>
        <p>회의록, 결정 대기함, 에이전트 질의를 한 화면에서 다룹니다. 이 UI는 기록과 승인 보조만 수행하며 거래·파라미터를 변경하지 않습니다.</p>
      </div>
      <div style=${{ minWidth: '260px' }}>
        <label className="meta">MEETING_ROOM_TOKEN</label>
        <input value=${token} onChange=${(event) => setToken(event.target.value)} placeholder="로컬 무인증이면 비워둠" />
      </div>
    </div>
    <div className="tabs">
      <button className=${tab === 'daily' ? 'active' : ''} onClick=${() => setTab('daily')}>일일 회의실</button>
      <button className=${tab === 'ask' ? 'active' : ''} onClick=${() => setTab('ask')}>에이전트 질의</button>
      <a className="pill" href="http://127.0.0.1:7787" target="_blank" rel="noreferrer">TeamJay Dashboard :7787</a>
    </div>
  `;
}

function MeetingList({ meetings, activeRuns, selectedId, setSelectedId }) {
  return html`
    <div className="card">
      <h2>회의 목록</h2>
      <div className="card-body list">
        ${activeRuns.map((run) => html`
          <button className=${`meeting-item ${selectedId === run.id ? 'active' : ''}`} onClick=${() => setSelectedId(run.id)}>
            <div className="meeting-title">${run.type} · ${run.status}</div>
            <div className="meta">${formatTime(run.startedAt)} · run</div>
          </button>
        `)}
        ${meetings.map((meeting) => html`
          <button className=${`meeting-item ${String(selectedId) === String(meeting.id) ? 'active' : ''}`} onClick=${() => setSelectedId(meeting.id)}>
            <div className="meeting-title">#${meeting.id} · ${meeting.type}</div>
            <div className="meta">${meeting.status} · ${formatTime(meeting.startedAt)}</div>
          </button>
        `)}
        ${meetings.length === 0 && activeRuns.length === 0 ? html`<div className="meta">회의 기록 없음</div>` : null}
      </div>
    </div>
  `;
}

function StartMeeting({ token, segments, onStarted, setError }) {
  const types = useMemo(() => meetingTypesForSegments(segments), [segments]);
  const [type, setType] = useState('morning');
  const [useLlm, setUseLlm] = useState(false);
  const [busy, setBusy] = useState(false);
  async function start() {
    setBusy(true);
    setError('');
    try {
      const payload = await api(token, '/api/meetings/start', {
        method: 'POST',
        body: JSON.stringify({ type, noLlm: !useLlm }),
      });
      onStarted(payload.run);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return html`
    <div className="form-row">
      <label className="meta">회의 시작</label>
      <div className="inline">
        <select value=${type} onChange=${(event) => setType(event.target.value)}>
          ${types.map((item) => html`<option value=${item.value} disabled=${item.disabled}>${item.label}</option>`)}
        </select>
        <button onClick=${start} disabled=${busy}>${busy ? '시작 중' : '회의 시작'}</button>
      </div>
      <label className="check"><input type="checkbox" checked=${useLlm} onChange=${(event) => setUseLlm(event.target.checked)} /> LLM 발언 사용(비용 가드 적용)</label>
    </div>
  `;
}

function Timeline({ detail, catchup }) {
  const minutes = detail?.minutes || [];
  return html`
    <div className="card">
      <h2>타임라인</h2>
      <div className="card-body">
        <div className="catchup">
          ${(catchup || ['회의를 선택하면 U1 캐치업이 표시됩니다.']).map((line) => html`<div>${line}</div>`)}
        </div>
        <pre>${detail?.planNote?.briefMarkdown || ''}</pre>
        <div className="list" style=${{ marginTop: '14px' }}>
          ${minutes.map((minute) => html`
            <article className=${`minute ${minute.role}`}>
              <div className="meeting-title">${minute.seq}. ${minute.agendaKey} — ${roleName(minute.role)} / ${minute.speaker}</div>
              <div className="meta">${formatTime(minute.createdAt)}</div>
              <pre>${minute.content}</pre>
            </article>
          `)}
          ${minutes.length === 0 ? html`<div className="meta">선택된 회의의 minute가 없습니다.</div>` : null}
        </div>
      </div>
    </div>
  `;
}

function DecisionCard({ token, decision, onUpdated, setError }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  async function act(action) {
    setBusy(action);
    setError('');
    try {
      await api(token, `/api/decisions/${decision.id}`, {
        method: 'POST',
        body: JSON.stringify({ action, note }),
      });
      setNote('');
      onUpdated();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy('');
    }
  }
  return html`
    <article className="decision-card">
      <div className="meeting-title">#${decision.id} · ${decision.agendaKey}</div>
      <div className="meta">${decision.grade}/${decision.status} · due ${formatTime(decision.dueAt)}</div>
      <p>${decision.decision}</p>
      <details><summary>evidence</summary><pre>${JSON.stringify(decision.evidence || {}, null, 2)}</pre></details>
      <div className="form-row" style=${{ marginTop: '10px' }}>
        <input value=${note} onChange=${(event) => setNote(event.target.value)} placeholder="감사 note" />
        <div className="inline">
          <button onClick=${() => act('confirm')} disabled=${Boolean(busy)}>${busy === 'confirm' ? '확인 중' : 'confirm'}</button>
          <button className="warn" onClick=${() => act('defer')} disabled=${Boolean(busy)}>${busy === 'defer' ? '보류 중' : 'defer'}</button>
        </div>
      </div>
    </article>
  `;
}

function Decisions({ token, decisions, onUpdated, setError }) {
  return html`
    <div className="card">
      <h2>결정 대기함</h2>
      <div className="card-body list">
        ${decisions.map((decision) => html`<${DecisionCard} key=${decision.id} token=${token} decision=${decision} onUpdated=${onUpdated} setError=${setError} />`)}
        ${decisions.length === 0 ? html`<div className="meta">pending_master 결정 없음</div>` : null}
      </div>
    </div>
  `;
}

function DailyRoom({ token }) {
  const [meetings, setMeetings] = useState([]);
  const [activeRuns, setActiveRuns] = useState([]);
  const [segments, setSegments] = useState([]);
  const [pending, setPending] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [catchup, setCatchup] = useState([]);
  const [error, setError] = useState('');

  async function refreshBase() {
    const list = await api(token, '/api/meetings');
    setMeetings(list.meetings || []);
    setActiveRuns(list.activeRuns || []);
    setSegments(list.segments || []);
    const pendingPayload = await api(token, '/api/decisions/pending');
    setPending(pendingPayload.decisions || []);
    if (!selectedId && (list.activeRuns?.[0] || list.meetings?.[0])) {
      setSelectedId((list.activeRuns?.[0] || list.meetings?.[0]).id);
    }
  }

  async function refreshSelected(id = selectedId) {
    if (!id) return;
    const payload = await api(token, `/api/meetings/${id}`);
    if (payload.run) {
      setDetail({ session: payload.run, minutes: [], decisions: [] });
      setCatchup([`실행 상태: ${payload.run.status}`, `세션: ${payload.run.sessionId || '생성 중'}`, `완료: ${payload.run.completedAt || '대기'}`]);
      return;
    }
    setDetail(payload);
    const catchupPayload = await api(token, `/api/catchup/${id}`);
    setCatchup(catchupPayload.lines || []);
  }

  useEffect(() => {
    refreshBase().catch((error) => setError(error.message));
  }, [token]);

  useEffect(() => {
    refreshSelected().catch((error) => setError(error.message));
  }, [selectedId, token]);

  useEffect(() => {
    const hasOpen = activeRuns.some((run) => run.status === 'running');
    const interval = setInterval(() => {
      refreshBase().then(() => refreshSelected()).catch((error) => setError(error.message));
    }, hasOpen ? 3000 : 30000);
    return () => clearInterval(interval);
  }, [activeRuns.map((run) => run.id + run.status).join(','), selectedId, token]);

  return html`
    ${error ? html`<p className="error">${error}</p>` : null}
    <div className="grid">
      <div>
        <${StartMeeting} token=${token} segments=${segments} onStarted=${(run) => { setSelectedId(run.id); refreshBase(); }} setError=${setError} />
        <${MeetingList} meetings=${meetings} activeRuns=${activeRuns} selectedId=${selectedId} setSelectedId=${setSelectedId} />
      </div>
      <${Timeline} detail=${detail} catchup=${catchup} />
      <${Decisions} token=${token} decisions=${pending} onUpdated=${() => { refreshBase(); refreshSelected(); }} setError=${setError} />
    </div>
  `;
}

function AskRoom({ token }) {
  const [agent, setAgent] = useState('luna');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function ask() {
    setBusy(true);
    setError('');
    try {
      setAnswer(await api(token, '/api/agents/ask', {
        method: 'POST',
        body: JSON.stringify({ agent, question }),
      }));
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return html`
    ${error ? html`<p className="error">${error}</p>` : null}
    <div className="ask-grid">
      <div className="card">
        <h2>@멘션 질의</h2>
        <div className="card-body">
          <div className="form-row">
            <label className="meta">agent</label>
            <select value=${agent} onChange=${(event) => setAgent(event.target.value)}>
              ${['luna', 'aria', 'sophia', 'argos', 'hermes', 'oracle', 'zeus', 'athena'].map((name) => html`<option value=${name}>${name}</option>`)}
            </select>
          </div>
          <div className="form-row">
            <label className="meta">question</label>
            <textarea value=${question} onChange=${(event) => setQuestion(event.target.value)} placeholder="회의실 컨텍스트 기반 advisory 질문" />
          </div>
          <button onClick=${ask} disabled=${busy || !question.trim()}>${busy ? '질의 중' : '질의 보내기'}</button>
        </div>
      </div>
      <div className="card">
        <h2>응답</h2>
        <div className="card-body">
          <div className="answer">
            ${answer ? html`
              <div className="meta">${answer.agent} · ${answer.provider || answer.route?.provider || 'n/a'} · ok=${String(answer.ok)}</div>
              <pre>${answer.text || answer.error || '응답 없음'}</pre>
            ` : html`<div className="meta">아직 응답 없음</div>`}
          </div>
        </div>
      </div>
    </div>
  `;
}

function App() {
  const [token, setToken] = useToken();
  const [tab, setTab] = useState('daily');
  return html`
    <main className="shell">
      <${Header} token=${token} setToken=${setToken} tab=${tab} setTab=${setTab} />
      ${tab === 'daily' ? html`<${DailyRoom} token=${token} />` : html`<${AskRoom} token=${token} />`}
    </main>
  `;
}

ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);
