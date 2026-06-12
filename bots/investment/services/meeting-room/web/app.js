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

function friendlyApiError(status, code, fallback) {
  return {
    unauthorized: '토큰이 없거나 올바르지 않습니다. MEETING_ROOM_TOKEN을 확인하세요.',
    meeting_already_open: '이미 진행 중인 같은 타입 회의가 있습니다. 완료 후 다시 시도하세요.',
    segment_closed: '해당 시장 세그먼트가 휴장/비활성 상태라 회의를 시작할 수 없습니다.',
    ask_rate_limited_minute: '분당 질의 한도에 도달했습니다. 잠시 후 다시 시도하세요.',
    ask_rate_limited_day: '일일 질의 한도에 도달했습니다. 다음 운영일에 다시 시도하세요.',
    body_too_large: '요청 본문이 너무 큽니다. 질문이나 메모를 줄여 주세요.',
    invalid_json: '요청 형식이 올바르지 않습니다.',
  }[code] || (status >= 500 ? '회의실 서버 오류가 발생했습니다. 잠시 후 다시 시도하세요.' : fallback || `HTTP ${status}`);
}

function normalizeApiError(error) {
  if (error?.status) return error;
  const normalized = new Error('회의실 서버에 연결할 수 없습니다. 서버 상태를 확인한 뒤 다시 시도하세요.');
  normalized.cause = error;
  return normalized;
}

function api(token, path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.body && !headers['content-type']) headers['content-type'] = 'application/json';
  return fetch(path, { ...options, headers }).then(async (res) => {
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(friendlyApiError(res.status, payload.error, payload.message || payload.error || `HTTP ${res.status}`));
      error.status = res.status;
      error.payload = payload;
      error.code = payload.error || null;
      throw error;
    }
    return payload;
  }).catch((error) => {
    throw normalizeApiError(error);
  });
}

function isAdrMinute(minute = {}) {
  return String(minute.speaker || '').toLowerCase() === 'adr' || String(minute.role || '').toLowerCase() === 'adr';
}

function roleName(role, minute = {}) {
  if (isAdrMinute(minute)) return 'ADR';
  return { data: '데이터', analysis: '분석', grill: '그릴', decision: '결정', system: '시스템' }[role] || role;
}

function minuteClassName(minute = {}) {
  return `minute ${minute.role || 'system'}${isAdrMinute(minute) ? ' adr' : ''}`;
}

function dueState(value, now = new Date()) {
  if (!value) return { className: 'due unknown', label: 'due n/a', title: '기한 확인 필요: due 값 없음' };
  const due = new Date(value);
  if (Number.isNaN(due.getTime())) return { className: 'due unknown', label: `due ${String(value)}`, title: `기한 확인 필요: ${String(value)}` };
  const deltaMs = due.getTime() - now.getTime();
  if (deltaMs < 0) return { className: 'due overdue', label: `경과 ${formatTime(value)}`, title: `기한 경과: ${formatTime(value)}` };
  if (deltaMs <= 24 * 60 * 60 * 1000) return { className: 'due soon', label: `임박 ${formatTime(value)}`, title: `기한 임박: ${formatTime(value)}` };
  return { className: 'due normal', label: `due ${formatTime(value)}`, title: `기한 정상: ${formatTime(value)}` };
}

function decisionGradeLabel(value) {
  return {
    a_rule: 'A 룰 승인 후보',
    b_boundary: 'B 경계 검토',
    c_master: 'C 마스터 확인',
  }[value] || '등급 미분류';
}

function decisionStatusLabel(value) {
  return {
    pending_master: '마스터 액션 대기',
    confirmed: '확정됨',
    deferred: '보류됨',
  }[value] || '상태 미분류';
}

function answerStatusLabel(ok) {
  if (ok === true) return '성공';
  if (ok === false) return '실패';
  return '확인 필요';
}

function renderInlineMarkdown(text, keyPrefix = 'inline') {
  const source = String(text ?? '');
  const nodes = [];
  let cursor = 0;
  let index = 0;
  const boldPattern = /\*\*([^*]+)\*\*/g;
  for (const match of source.matchAll(boldPattern)) {
    if (match.index > cursor) nodes.push(source.slice(cursor, match.index));
    nodes.push(html`<b key=${`${keyPrefix}-b-${index++}`}>${match[1]}</b>`);
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) nodes.push(source.slice(cursor));
  return nodes.length ? nodes : [source];
}

function isTableLine(line) {
  return /^\s*\|.*\|\s*$/.test(String(line || '')) && splitTableRow(line).length > 1;
}

function isTableSeparator(cells = []) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(String(cell || '').trim()));
}

function splitTableRow(line) {
  return String(line || '')
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function renderMarkdownTable(lines, keyPrefix) {
  const rows = lines.map(splitTableRow);
  const hasHeader = rows.length > 1 && isTableSeparator(rows[1]);
  const header = hasHeader ? rows[0] : null;
  const body = hasHeader ? rows.slice(2) : rows.filter((row) => !isTableSeparator(row));
  return html`
    <table className="markdown-table" key=${`${keyPrefix}-table`}>
      ${header ? html`
        <thead>
          <tr>${header.map((cell, index) => html`<th key=${`${keyPrefix}-th-${index}`}>${renderInlineMarkdown(cell, `${keyPrefix}-th-${index}`)}</th>`)}</tr>
        </thead>
      ` : null}
      <tbody>
        ${body.map((row, rowIndex) => html`
          <tr key=${`${keyPrefix}-tr-${rowIndex}`}>
            ${row.map((cell, cellIndex) => html`<td key=${`${keyPrefix}-td-${rowIndex}-${cellIndex}`}>${renderInlineMarkdown(cell, `${keyPrefix}-td-${rowIndex}-${cellIndex}`)}</td>`)}
          </tr>
        `)}
      </tbody>
    </table>
  `;
}

function renderMarkdownLite(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const key = `md-${index}`;
    if (isTableLine(line)) {
      const tableLines = [];
      while (index < lines.length && isTableLine(lines[index])) tableLines.push(lines[index++]);
      blocks.push(renderMarkdownTable(tableLines, key));
      continue;
    }
    if (line.startsWith('#### ')) {
      blocks.push(html`<h4 key=${key}>${renderInlineMarkdown(line.slice(5), key)}</h4>`);
      index += 1;
      continue;
    }
    if (line.startsWith('### ')) {
      blocks.push(html`<h3 key=${key}>${renderInlineMarkdown(line.slice(4), key)}</h3>`);
      index += 1;
      continue;
    }
    if (line.startsWith('- ')) {
      const items = [];
      while (index < lines.length && lines[index].startsWith('- ')) {
        const itemKey = `md-li-${index}`;
        items.push(html`<li key=${itemKey}>${renderInlineMarkdown(lines[index].slice(2), itemKey)}</li>`);
        index += 1;
      }
      blocks.push(html`<ul key=${key}>${items}</ul>`);
      continue;
    }
    blocks.push(line === ''
      ? html`<br key=${key} />`
      : html`<div className="markdown-line" key=${key}>${renderInlineMarkdown(line, key)}</div>`);
    index += 1;
  }
  return html`<div className="markdown-lite">${blocks}</div>`;
}

function MarkdownLite({ text }) {
  try {
    return renderMarkdownLite(text);
  } catch (error) {
    return html`<pre>${String(text ?? '')}</pre>`;
  }
}

function meetingTypesForSegments(segments = []) {
  const domestic = segments.find((row) => row.market === 'domestic');
  const overseas = segments.find((row) => row.market === 'overseas');
  return [
    { value: 'morning', label: '아침 통합 회의', disabled: false },
    { value: 'domestic_debrief', label: `국내 장후 회의${domestic?.skipped ? ` (${domestic.reason})` : ''}`, disabled: domestic?.skipped === true, reason: domestic?.reason },
    { value: 'us_premarket', label: `미장 전 회의${overseas?.skipped ? ` (${overseas.reason})` : ''}`, disabled: overseas?.skipped === true, reason: overseas?.reason },
    { value: 'weekly', label: '주간 회의', disabled: false },
    { value: 'adhoc', label: '임시 회의', disabled: false },
  ];
}

function marketLabel(market) {
  return { domestic: '국내', overseas: '미국', crypto: 'crypto' }[market] || market || 'unknown';
}

function SegmentStatus({ segments }) {
  if (!segments?.length) return html`<div id="meeting-segment-status" className="meta" role="status" aria-live="polite" aria-label="시장 세그먼트 상태">세그먼트 상태 로딩 중</div>`;
  return html`
    <div id="meeting-segment-status" className="segment-status" role="status" aria-live="polite" aria-label="시장 세그먼트 상태">
      ${segments.map((segment) => html`
        <span
          className=${`segment-pill ${segment.skipped ? 'closed' : 'active'}`}
          title=${segment.skipped ? `${marketLabel(segment.market)} 비활성: ${segment.reason || '사유 없음'}` : `${marketLabel(segment.market)} active`}
          aria-label=${segment.skipped ? `${marketLabel(segment.market)} 비활성, 사유 ${segment.reason || '사유 없음'}` : `${marketLabel(segment.market)} active`}
        >
          ${marketLabel(segment.market)} · ${segment.skipped ? `비활성(${segment.reason || '사유 없음'})` : 'active'}
        </span>
      `)}
    </div>
  `;
}

function Header({ token, setToken, tab, setTab }) {
  function selectTab(nextTab) {
    setTab(nextTab);
    requestAnimationFrame(() => {
      document.getElementById(nextTab === 'daily' ? 'meeting-tab-daily' : 'meeting-tab-ask')?.focus();
    });
  }
  function handleTabKeyDown(event) {
    const nextTab = {
      ArrowLeft: tab === 'daily' ? 'ask' : 'daily',
      ArrowUp: tab === 'daily' ? 'ask' : 'daily',
      ArrowRight: tab === 'daily' ? 'ask' : 'daily',
      ArrowDown: tab === 'daily' ? 'ask' : 'daily',
      Home: 'daily',
      End: 'ask',
    }[event.key];
    if (!nextTab) return;
    event.preventDefault();
    selectTab(nextTab);
  }
  return html`
    <div className="hero">
      <div>
        <div className="topline" role="status" aria-label="회의실 실행 상태">
          <span className="pill" aria-label="회의실 버전 MR-B">MR-B</span>
          <span className="pill" aria-label="자문 및 섀도 전용">advisory / shadow only</span>
          <span className="pill" aria-label="로컬 바인딩 127.0.0.1 포트 7791">127.0.0.1:7791</span>
        </div>
        <h1>Luna Meeting Room</h1>
        <p>회의록, 결정 대기함, 에이전트 질의를 한 화면에서 다룹니다. 이 UI는 기록과 승인 보조만 수행하며 거래·파라미터를 변경하지 않습니다.</p>
      </div>
      <div style=${{ minWidth: '260px' }}>
        <label className="meta" htmlFor="meeting-room-token">접근 토큰 (MEETING_ROOM_TOKEN)</label>
        <input
          id="meeting-room-token"
          type="password"
          autoComplete="off"
          aria-label="회의실 접근 토큰"
          value=${token}
          onChange=${(event) => setToken(event.target.value)}
          placeholder="로컬 무인증이면 비워둠"
        />
      </div>
    </div>
    <div className="tabs">
      <div className="tab-switcher" role="tablist" aria-label="회의실 화면 전환">
        <button
          id="meeting-tab-daily"
          role="tab"
          className=${tab === 'daily' ? 'active' : ''}
          aria-selected=${tab === 'daily'}
          aria-pressed=${tab === 'daily'}
          aria-controls="meeting-panel-daily"
          tabIndex=${tab === 'daily' ? 0 : -1}
          onClick=${() => selectTab('daily')}
          onKeyDown=${handleTabKeyDown}
        >일일 회의실</button>
        <button
          id="meeting-tab-ask"
          role="tab"
          className=${tab === 'ask' ? 'active' : ''}
          aria-selected=${tab === 'ask'}
          aria-pressed=${tab === 'ask'}
          aria-controls="meeting-panel-ask"
          tabIndex=${tab === 'ask' ? 0 : -1}
          onClick=${() => selectTab('ask')}
          onKeyDown=${handleTabKeyDown}
        >에이전트 질의</button>
      </div>
      <a
        className="pill"
        href="http://127.0.0.1:7787"
        target="_blank"
        rel="noreferrer"
        aria-label="TeamJay Dashboard 7787 새 창으로 열기"
        title="TeamJay Dashboard 7787 새 창으로 열기"
      >TeamJay Dashboard :7787</a>
    </div>
  `;
}

function MeetingList({ meetings, activeRuns, selectedId, setSelectedId }) {
  const totalCount = meetings.length + activeRuns.length;
  return html`
    <div className="card" role="region" aria-label="회의 목록">
      <h2>회의 목록</h2>
      <div className="card-body list" role="list" aria-live="polite" aria-label=${`회의 목록 ${totalCount}건`}>
        ${activeRuns.map((run) => html`
          <div className="meeting-list-row" role="listitem">
            <button
              className=${`meeting-item ${selectedId === run.id ? 'active' : ''}`}
              aria-pressed=${selectedId === run.id}
              aria-label=${`실행 중 회의 ${run.type} ${run.status} 선택`}
              onClick=${() => setSelectedId(run.id)}
            >
              <div className="meeting-title">${run.type} · ${run.status}</div>
              <div className="meta">${formatTime(run.startedAt)} · run</div>
            </button>
          </div>
        `)}
        ${meetings.map((meeting) => html`
          <div className="meeting-list-row" role="listitem">
            <button
              className=${`meeting-item ${String(selectedId) === String(meeting.id) ? 'active' : ''}`}
              aria-pressed=${String(selectedId) === String(meeting.id)}
              aria-label=${`회의 #${meeting.id} ${meeting.type} ${meeting.status} 선택`}
              onClick=${() => setSelectedId(meeting.id)}
            >
              <div className="meeting-title">#${meeting.id} · ${meeting.type}</div>
              <div className="meta">${meeting.status} · ${formatTime(meeting.startedAt)}</div>
            </button>
          </div>
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
  const selectedType = types.find((item) => item.value === type) || types[0];
  const selectedTypeDisabled = selectedType?.disabled === true;
  const startDisabled = busy || selectedTypeDisabled;
  async function start() {
    if (selectedTypeDisabled) return;
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
      <label className="meta" htmlFor="meeting-type-select">회의 시작</label>
      <div className="inline">
        <select id="meeting-type-select" aria-label="시작할 회의 타입" aria-describedby="meeting-segment-status" value=${type} onChange=${(event) => setType(event.target.value)}>
          ${types.map((item) => html`
            <option
              value=${item.value}
              disabled=${item.disabled}
              title=${item.disabled ? `${item.label} 비활성: ${item.reason || '사유 없음'}` : item.label}
              aria-label=${item.disabled ? `${item.label} 비활성, 사유 ${item.reason || '사유 없음'}` : item.label}
            >${item.label}</option>
          `)}
        </select>
        <button
          aria-label=${selectedTypeDisabled ? `${selectedType?.label || type} 시작 불가, 사유 ${selectedType?.reason || '비활성'}` : `${selectedType?.label || type} 시작`}
          title=${selectedTypeDisabled ? `${selectedType?.label || type}는 현재 비활성 상태입니다: ${selectedType?.reason || '사유 없음'}` : `${selectedType?.label || type}를 advisory/shadow 회의로 시작합니다.`}
          onClick=${start}
          disabled=${startDisabled}
        >${busy ? '시작 중' : '회의 시작'}</button>
      </div>
      ${selectedTypeDisabled ? html`<div className="meta" role="status" aria-live="polite">선택한 회의 타입은 현재 비활성입니다: ${selectedType?.reason || '사유 없음'}</div>` : null}
      <${SegmentStatus} segments=${segments} />
      <label className="check" htmlFor="meeting-llm-toggle"><input id="meeting-llm-toggle" type="checkbox" aria-describedby="meeting-llm-mode" checked=${useLlm} onChange=${(event) => setUseLlm(event.target.checked)} /> LLM 발언 사용(비용 가드 적용)</label>
      <div id="meeting-llm-mode" className=${`llm-mode ${useLlm ? 'enabled' : 'disabled'}`} role="status" aria-live="polite" aria-label="LLM 발언 모드">
        현재 모드: ${useLlm ? 'LLM 발언 사용 · 비용 가드 적용' : '결정론 발언 · LLM 비용 0'}
      </div>
    </div>
  `;
}

function Timeline({ detail, catchup, loading }) {
  const minutes = detail?.minutes || [];
  const catchupLines = loading
    ? ['회의 상세를 불러오는 중입니다.']
    : (catchup?.length ? catchup : ['회의를 선택하면 U1 캐치업이 표시됩니다.']);
  const catchupLabel = `U1 캐치업 요약: ${catchupLines.join(' / ')}`;
  const roleLegend = [
    ['system', '시스템'],
    ['data', '데이터'],
    ['analysis', '분석'],
    ['grill', '그릴'],
    ['decision', '결정'],
    ['adr', 'ADR'],
  ];
  return html`
    <div className="card" role="region" aria-label="회의 타임라인">
      <h2>타임라인</h2>
      <div className="card-body">
        <div className="catchup" role="status" aria-live="polite" aria-label=${catchupLabel}>
          <div role="list" aria-label=${`U1 캐치업 ${catchupLines.length}줄 요약`}>
            ${catchupLines.map((line) => html`<div className="catchup-line" role="listitem">${line}</div>`)}
          </div>
        </div>
        <div className="role-legend" role="list" aria-label="타임라인 역할 색상 범례">
          ${roleLegend.map(([role, label]) => html`
            <span className="role-chip" role="listitem" aria-label=${`${label} 역할 색상`}>
              <span className=${`role-dot ${role}`} aria-hidden="true"></span>${label}
            </span>
          `)}
        </div>
        <${MarkdownLite} text=${detail?.planNote?.briefMarkdown || ''} />
        <div className="list" style=${{ marginTop: '14px' }}>
          ${minutes.map((minute) => html`
            <article
              className=${minuteClassName(minute)}
              aria-label=${`${minute.seq}번 minute · ${minute.agendaKey || 'session'} · ${roleName(minute.role, minute)} · ${minute.speaker || 'unknown'}`}
            >
              <div className="meeting-title">${minute.seq}. ${minute.agendaKey} — ${roleName(minute.role, minute)} / ${minute.speaker}</div>
              <div className="meta">${formatTime(minute.createdAt)}</div>
              <${MarkdownLite} text=${minute.content} />
            </article>
          `)}
          ${loading ? html`<div className="meta">상세 로딩 중...</div>` : null}
          ${!loading && minutes.length === 0 ? html`<div className="meta">선택된 회의의 minute가 없습니다.</div>` : null}
        </div>
      </div>
    </div>
  `;
}

function DecisionCard({ token, decision, onUpdated, setError, setNotice }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const due = dueState(decision.dueAt);
  async function act(action) {
    setBusy(action);
    setError('');
    setNotice('');
    try {
      const result = await api(token, `/api/decisions/${decision.id}`, {
        method: 'POST',
        body: JSON.stringify({ action, note }),
      });
      if (result.idempotent === true) {
        setNotice('이미 처리된 결정입니다. 최신 상태로 갱신했습니다.');
      }
      setNote('');
      onUpdated();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy('');
    }
  }
  return html`
    <article
      className="decision-card"
      role="listitem"
      aria-label=${`결정 #${decision.id} · ${decision.agendaKey || 'unknown'} · ${decisionGradeLabel(decision.grade)} · ${decisionStatusLabel(decision.status)} · ${due.label}`}
    >
      <div className="meeting-title">#${decision.id} · ${decision.agendaKey}</div>
      <div className="meta decision-state">
        <span title=${`원문 등급: ${decision.grade || 'n/a'}`}>${decisionGradeLabel(decision.grade)}</span>
        <span title=${`원문 상태: ${decision.status || 'n/a'}`}>${decisionStatusLabel(decision.status)}</span>
        <span className=${due.className} title=${due.title} aria-label=${due.title}>${due.label}</span>
      </div>
      <${MarkdownLite} text=${decision.decision} />
      <details><summary aria-label=${`결정 #${decision.id} 근거 JSON 보기`}>근거 JSON 보기</summary><pre>${JSON.stringify(decision.evidence || {}, null, 2)}</pre></details>
      <div className="form-row" style=${{ marginTop: '10px' }}>
        <input value=${note} onChange=${(event) => setNote(event.target.value)} placeholder="감사 메모" aria-label=${`결정 #${decision.id} 감사 메모`} />
        <div className="inline">
          <button aria-label=${`결정 #${decision.id} 확정`} onClick=${() => act('confirm')} disabled=${Boolean(busy)}>${busy === 'confirm' ? '확정 중' : '확정'}</button>
          <button aria-label=${`결정 #${decision.id} 보류`} className="warn" onClick=${() => act('defer')} disabled=${Boolean(busy)}>${busy === 'defer' ? '보류 중' : '보류'}</button>
        </div>
      </div>
    </article>
  `;
}

function Decisions({ token, decisions, onUpdated, setError, setNotice }) {
  return html`
    <div className="card" role="region" aria-label="결정 대기함">
      <h2>결정 대기함</h2>
      <div className="card-body list" role="list" aria-live="polite" aria-label=${`마스터 액션 대기 결정 ${decisions.length}건`}>
        ${decisions.map((decision) => html`<${DecisionCard} key=${decision.id} token=${token} decision=${decision} onUpdated=${onUpdated} setError=${setError} setNotice=${setNotice} />`)}
        ${decisions.length === 0 ? html`<div className="meta">마스터 액션 대기 결정 없음</div>` : null}
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
  const [detailLoading, setDetailLoading] = useState(false);
  const [catchup, setCatchup] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  function clearDailyRoomData() {
    setMeetings([]);
    setActiveRuns([]);
    setSegments([]);
    setPending([]);
    setSelectedId(null);
    setDetail(null);
    setCatchup([]);
  }

  async function refreshBase() {
    try {
      const list = await api(token, '/api/meetings');
      setMeetings(list.meetings || []);
      setActiveRuns(list.activeRuns || []);
      setSegments(list.segments || []);
      const pendingPayload = await api(token, '/api/decisions/pending');
      setPending(pendingPayload.decisions || []);
      setError('');
      if (!selectedId && (list.activeRuns?.[0] || list.meetings?.[0])) {
        const nextId = (list.activeRuns?.[0] || list.meetings?.[0]).id;
        setSelectedId(nextId);
        await refreshSelected(nextId);
      }
    } catch (error) {
      clearDailyRoomData();
      throw error;
    }
  }

  async function refreshSelected(id = selectedId) {
    if (!id) return;
    setDetailLoading(true);
    try {
      const payload = await api(token, `/api/meetings/${id}`);
      if (payload.run) {
        if (payload.run.status === 'completed' && payload.run.sessionId) {
          setSelectedId(payload.run.sessionId);
          await refreshSelected(payload.run.sessionId);
          return;
        }
        setDetail({ session: payload.run, minutes: [], decisions: [] });
        setCatchup([
          `실행 상태: ${payload.run.status}`,
          `세션: ${payload.run.sessionId || '생성 중'}`,
          `완료: ${payload.run.completedAt || '대기'}`,
          ...(payload.run.status === 'failed' ? [`오류: ${payload.run.error || '원인 미상'}`] : []),
        ]);
        setError('');
        return;
      }
      setDetail(payload);
      const catchupPayload = await api(token, `/api/catchup/${id}`);
      setCatchup(catchupPayload.lines || []);
      setError('');
    } catch (error) {
      setDetail(null);
      setCatchup(['회의 상세를 불러오지 못했습니다.']);
      throw error;
    } finally {
      setDetailLoading(false);
    }
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
    ${error ? html`<p className="error" role="alert" aria-live="assertive">${error}</p>` : null}
    ${notice ? html`<p className="notice" role="status" aria-live="polite">${notice}</p>` : null}
    <div className="grid">
      <div>
        <${StartMeeting} token=${token} segments=${segments} onStarted=${(run) => { setSelectedId(run.id); refreshBase(); }} setError=${setError} />
        <${MeetingList} meetings=${meetings} activeRuns=${activeRuns} selectedId=${selectedId} setSelectedId=${setSelectedId} />
      </div>
      <${Timeline} detail=${detail} catchup=${catchup} loading=${detailLoading} />
      <${Decisions} token=${token} decisions=${pending} onUpdated=${() => { refreshBase(); refreshSelected(); }} setError=${setError} setNotice=${setNotice} />
    </div>
  `;
}

function AskRoom({ token }) {
  const [agent, setAgent] = useState('luna');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function updateAgent(value) {
    setAgent(value);
    setError('');
  }
  function updateQuestion(value) {
    setQuestion(value);
    setError('');
  }
  async function ask() {
    setBusy(true);
    setError('');
    setAnswer(null);
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
    ${error ? html`<p className="error" role="alert" aria-live="assertive">${error}</p>` : null}
    <div className="ask-grid">
      <div className="card">
        <h2>@멘션 질의</h2>
        <div className="card-body">
          <div className="form-row">
            <label className="meta" htmlFor="meeting-agent-select">에이전트</label>
            <select id="meeting-agent-select" aria-label="질의 대상 에이전트" value=${agent} onChange=${(event) => updateAgent(event.target.value)}>
              ${['luna', 'aria', 'sophia', 'argos', 'hermes', 'oracle', 'zeus', 'athena'].map((name) => html`<option value=${name}>${name}</option>`)}
            </select>
          </div>
          <div className="form-row">
            <label className="meta" htmlFor="meeting-agent-question">질문</label>
            <textarea
              id="meeting-agent-question"
              aria-label="회의실 컨텍스트 기반 advisory 질문"
              aria-describedby="ask-helper ask-safety-note"
              value=${question}
              onChange=${(event) => updateQuestion(event.target.value)}
              placeholder="회의실 컨텍스트 기반 advisory 질문"
            />
            <div id="ask-helper" className="ask-helper">질문을 입력하면 전송 버튼이 활성화됩니다.</div>
          </div>
          <div id="ask-safety-note" className="ask-safety-note">
            advisory only · LLM 호출 비용 가능 · 분당 2회 / 일 20회 한도
          </div>
          <button
            aria-label=${`${agent}에게 advisory 질문 보내기`}
            title=${question.trim() ? '선택한 에이전트에게 advisory 질문을 보냅니다.' : '질문을 입력하면 활성화됩니다.'}
            onClick=${ask}
            disabled=${busy || !question.trim()}
          >${busy ? '질의 중' : '질의 보내기'}</button>
        </div>
      </div>
      <div className="card">
        <h2>응답</h2>
        <div className="card-body">
          <div className="answer" role="status" aria-live="polite" aria-busy=${busy} aria-label="에이전트 질의 응답">
            ${busy ? html`<div className="meta">질의 중 · 에이전트 응답을 기다리는 중입니다.</div>` : answer ? html`
              <div className="meta">에이전트 ${answer.agent || agent} · 제공자 ${answer.provider || answer.route?.provider || 'n/a'} · 상태 ${answerStatusLabel(answer.ok)}</div>
              <${MarkdownLite} text=${answer.text || answer.error || '응답 없음'} />
            ` : html`<div className="meta">아직 응답 없음 · 질문을 입력한 뒤 질의 보내기를 누르세요.</div>`}
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
      <section
        id=${tab === 'daily' ? 'meeting-panel-daily' : 'meeting-panel-ask'}
        role="tabpanel"
        aria-labelledby=${tab === 'daily' ? 'meeting-tab-daily' : 'meeting-tab-ask'}
      >
        ${tab === 'daily' ? html`<${DailyRoom} token=${token} />` : html`<${AskRoom} token=${token} />`}
      </section>
    </main>
  `;
}

ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);
