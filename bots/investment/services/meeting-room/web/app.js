const html = htm.bind(React.createElement);
const { useEffect, useMemo, useRef, useState } = React;

const AGENT_OPTIONS = Object.freeze([
  'luna',
  'nemesis',
  'aria',
  'sophia',
  'argos',
  'hermes',
  'oracle',
  'chronos',
  'zeus',
  'athena',
  'sentinel',
  'adaptive-risk',
  'hephaestos',
  'hanul',
  'budget',
  'scout',
  'kairos',
  'stock-flow',
  'sweeper',
  'reporter',
]);

const AGENT_LABELS = Object.freeze({
  luna: 'Luna',
  nemesis: 'Nemesis',
  aria: 'Aria',
  sophia: 'Sophia',
  argos: 'Argos',
  hermes: 'Hermes',
  oracle: 'Oracle',
  chronos: 'Chronos',
  zeus: 'Zeus',
  athena: 'Athena',
  sentinel: 'Sentinel',
  'adaptive-risk': 'Adaptive Risk',
  hephaestos: 'Hephaestos',
  hanul: 'Hanul',
  budget: 'Budget',
  scout: 'Scout',
  kairos: 'Kairos',
  'stock-flow': 'Stock Flow',
  sweeper: 'Sweeper',
  reporter: 'Reporter',
});

const TOKEN_STORAGE_KEY = 'lunaMeetingRoomToken';
const ASK_AGENT_STORAGE_KEY = 'lunaMeetingRoomAskAgent';
const ASK_QUESTION_STORAGE_KEY = 'lunaMeetingRoomAskQuestion';
const MEETING_START_MALFORMED_MESSAGE = '회의 시작 응답이 올바르지 않습니다. 잠시 후 다시 시도하세요.';

function useToken() {
  const [token, setToken] = useState(() => readLocalValue(TOKEN_STORAGE_KEY, ''));
  function update(value) {
    setToken(value);
    writeLocalValue(TOKEN_STORAGE_KEY, value);
  }
  return [token, update];
}

function readLocalValue(key, fallback = '') {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function writeLocalValue(key, value) {
  try {
    if (typeof localStorage === 'undefined') return;
    const nextValue = String(value || '');
    if (nextValue) localStorage.setItem(key, nextValue);
    else localStorage.removeItem(key);
  } catch {
    // Storage can be disabled in hardened browser contexts. The UI still works without token persistence.
  }
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function readSessionValue(key, fallback = '') {
  try {
    if (typeof sessionStorage === 'undefined') return fallback;
    return sessionStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function writeSessionValue(key, value) {
  try {
    if (typeof sessionStorage === 'undefined') return;
    const nextValue = String(value || '');
    if (nextValue) sessionStorage.setItem(key, nextValue);
    else sessionStorage.removeItem(key);
  } catch {
    // Storage can be disabled in hardened browser contexts. The UI still works without draft restore.
  }
}

function normalizeAgentName(value) {
  const normalized = String(value || '').toLowerCase();
  return AGENT_OPTIONS.includes(normalized) ? normalized : 'luna';
}

function formatTime(value) {
  if (!value) return '시간 없음';
  try {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? '시간 확인 필요'
      : date.toLocaleString('ko-KR', { hour12: false });
  } catch {
    return '시간 확인 필요';
  }
}

function meetingStatusLabel(status) {
  return {
    open: '진행 중',
    running: '실행 중',
    completed: '완료',
    closed: '완료',
    failed: '실패',
  }[String(status || '').toLowerCase()] || '상태 미상';
}

function meetingTypeLabel(type) {
  return {
    morning: '아침 통합 회의',
    domestic_debrief: '국내 장후 회의',
    us_premarket: '미장 전 회의',
    weekly: '주간 회의',
    adhoc: '임시 회의',
    ad_hoc: '임시 회의',
  }[String(type || '').toLowerCase()] || '회의';
}

function agentLabel(agent) {
  return AGENT_LABELS[String(agent || '').toLowerCase()] || '에이전트 미상';
}

function providerLabel(provider) {
  const value = provider || '확인 필요';
  const normalized = String(value).toLowerCase();
  if (normalized === 'n/a' || normalized === 'none') return '확인 필요';
  if (normalized === 'rule_based' || normalized === 'rule-based' || normalized === 'deterministic') return '규칙 기반';
  return value;
}

function agendaLabel(key) {
  return {
    session: '세션',
    'market:domestic': '국내 장전 계획',
    'market:overseas': '미국 장후 평가',
    'market:crypto': '암호화폐 24시간 점검',
    'decision:regime-engine-hmm': 'C15 레짐 엔진 HMM',
    'decision:market-deployment-gate': 'C1 시장 배치 게이트',
    'decision:mapek': 'C15 MAPEK',
    'decision:meeting-room-orchestrator': '회의실 오케스트레이터',
    'decision:backtest-nextbar-execution': 'Next-bar 백테스트 실행',
    'alerts:circuit-locks': '서킷 잠금 알림',
    'debrief:g6-plan-vs-actual': '국내 마감 G6 대조표',
    'premarket:overseas-gate-regime': '미장 전 게이트·레짐 점검',
    'premarket:overseas-watch': '미장 전 감시 목록 점검',
    'weekly:shadow-stack-review': '주간 섀도 스택 리뷰',
  }[String(key || '')] || '안건';
}

function speakerLabel(speaker) {
  const value = String(speaker || '').toLowerCase();
  return {
    system: '시스템',
    'stack-adapter': '데이터 어댑터',
    adr: 'ADR 기록기',
    unknown: '알 수 없음',
  }[value] || agentLabel(speaker);
}

function friendlyApiError(status, code, fallback) {
  return {
    unauthorized: '토큰이 없거나 올바르지 않습니다. MEETING_ROOM_TOKEN을 확인하세요.',
    meeting_already_open: '이미 진행 중인 같은 타입 회의가 있습니다. 완료 후 다시 시도하세요.',
    segment_closed: '해당 시장 세그먼트가 휴장/비활성 상태라 회의를 시작할 수 없습니다.',
    ask_rate_limited_minute: '분당 질의 한도에 도달했습니다. 1분 후 다시 시도하세요.',
    ask_rate_limited_day: '일일 질의 한도에 도달했습니다. 다음 운영일에 다시 시도하세요.',
    body_too_large: '요청 본문이 너무 큽니다. 질문이나 메모를 줄여 주세요.',
    invalid_json: '요청 형식이 올바르지 않습니다.',
    invalid_agent: '지원하지 않는 에이전트입니다. 목록에서 에이전트를 선택하세요.',
    question_required: '질문을 입력하세요.',
    invalid_action: '지원하지 않는 결정 처리 요청입니다.',
    method_not_allowed: '지원하지 않는 요청 방식입니다.',
    meeting_not_found: '회의를 찾을 수 없습니다. 목록을 새로고침하세요.',
    not_found: '요청한 회의실 리소스를 찾을 수 없습니다.',
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
  const value = String(role || '').toLowerCase();
  return { data: '데이터', analysis: '분석', grill: '그릴', decision: '결정', system: '시스템' }[value] || '역할 미상';
}

function minuteRoleClass(minute = {}) {
  if (isAdrMinute(minute)) return 'adr';
  const value = String(minute.role || 'system').toLowerCase();
  return ['data', 'analysis', 'grill', 'decision', 'system'].includes(value) ? value : 'system';
}

function minuteClassName(minute = {}) {
  return `minute ${minuteRoleClass(minute)}${isAdrMinute(minute) ? ' adr' : ''}`;
}

function dueState(value, now = new Date()) {
  if (!value) return { className: 'due unknown', label: '기한 확인 필요', title: '기한 확인 필요: 값 없음' };
  const due = new Date(value);
  if (Number.isNaN(due.getTime())) return { className: 'due unknown', label: '기한 확인 필요', title: `기한 확인 필요: ${String(value)}` };
  const deltaMs = due.getTime() - now.getTime();
  if (deltaMs < 0) return { className: 'due overdue', label: `경과 ${formatTime(value)}`, title: `기한 경과: ${formatTime(value)}` };
  if (deltaMs <= 24 * 60 * 60 * 1000) return { className: 'due soon', label: `임박 ${formatTime(value)}`, title: `기한 임박: ${formatTime(value)}` };
  return { className: 'due normal', label: `정상 ${formatTime(value)}`, title: `기한 정상: ${formatTime(value)}` };
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
  function pushBlock(node) {
    blocks.push(node, '\n');
  }
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const key = `md-${index}`;
    if (isTableLine(line)) {
      const tableLines = [];
      while (index < lines.length && isTableLine(lines[index])) tableLines.push(lines[index++]);
      pushBlock(renderMarkdownTable(tableLines, key));
      continue;
    }
    if (line.startsWith('#### ')) {
      pushBlock(html`<h4 key=${key}>${renderInlineMarkdown(line.slice(5), key)}</h4>`);
      index += 1;
      continue;
    }
    if (line.startsWith('### ')) {
      pushBlock(html`<h3 key=${key}>${renderInlineMarkdown(line.slice(4), key)}</h3>`);
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
      pushBlock(html`<ul key=${key}>${items}</ul>`);
      continue;
    }
    pushBlock(line === ''
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

function segmentReasonLabel(reason) {
  const value = String(reason || '');
  if (!value) return '사유 없음';
  return {
    weekend: '주말',
    holiday: '휴장일',
    market_closed: '장 마감',
    kis_market_closed: '장 마감',
    crypto_24h: '24시간 운영',
    closed: '비활성',
    disabled: '비활성',
  }[value] || '사유 확인 필요';
}

function meetingTypesForSegments(segments = []) {
  const segmentRows = safeArray(segments);
  const domestic = segmentRows.find((row) => row.market === 'domestic');
  const overseas = segmentRows.find((row) => row.market === 'overseas');
  const domesticReason = segmentReasonLabel(domestic?.reason);
  const overseasReason = segmentReasonLabel(overseas?.reason);
  return [
    { value: 'morning', label: '아침 통합 회의', disabled: false },
    { value: 'domestic_debrief', label: `국내 장후 회의${domestic?.skipped ? ` (${domesticReason})` : ''}`, disabled: domestic?.skipped === true, reason: domestic?.reason, reasonLabel: domesticReason },
    { value: 'us_premarket', label: `미장 전 회의${overseas?.skipped ? ` (${overseasReason})` : ''}`, disabled: overseas?.skipped === true, reason: overseas?.reason, reasonLabel: overseasReason },
    { value: 'weekly', label: '주간 회의', disabled: false },
    { value: 'adhoc', label: '임시 회의', disabled: false },
  ];
}

function marketLabel(market) {
  return { domestic: '국내', overseas: '미국', crypto: '암호화폐' }[market] || '시장 미상';
}

function segmentStatusText(segment = {}) {
  return segment.skipped
    ? `${marketLabel(segment.market)} 비활성, 사유 ${segmentReasonLabel(segment.reason)}`
    : `${marketLabel(segment.market)} 활성`;
}

function segmentStatusVisibleText(segment = {}) {
  return `${marketLabel(segment.market)} · ${segment.skipped ? `비활성(${segmentReasonLabel(segment.reason)})` : '활성'}`;
}

function SegmentStatus({ segments }) {
  const segmentRows = safeArray(segments);
  if (!segmentRows.length) return html`<div id="meeting-segment-status" className="meta" role="status" aria-live="polite" aria-label="시장 세그먼트 상태">세그먼트 상태 로딩 중</div>`;
  const summary = segmentRows.map(segmentStatusText).join(' / ');
  const pills = segmentRows.flatMap((segment, index) => [
    html`
      <span
        key=${`segment-${segment.market || index}`}
        className=${`segment-pill ${segment.skipped ? 'closed' : 'active'}`}
        title=${segment.skipped ? `${marketLabel(segment.market)} 비활성: ${segmentReasonLabel(segment.reason)}` : `${marketLabel(segment.market)} 활성`}
        aria-label=${segmentStatusText(segment)}
      >
        ${segmentStatusVisibleText(segment)}
      </span>
    `,
    index < segmentRows.length - 1 ? ' ' : '',
  ]);
  return html`
    <div id="meeting-segment-status" className="segment-status" role="status" aria-live="polite" aria-label=${`시장 세그먼트 상태: ${summary}`}>
      ${pills}
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
        <div className="topline" role="status" aria-label="회의실 실행 상태: MR-B, 자문 및 섀도 전용, 로컬 바인딩 127.0.0.1 포트 7791">
          <span className="pill" aria-label="회의실 버전 MR-B">
            MR-B ·${' '}
          </span>
          <span className="pill" aria-label="자문 및 섀도 전용">
            자문 / 섀도 전용 ·${' '}
          </span>
          <span className="pill" aria-label="로컬 바인딩 127.0.0.1 포트 7791">127.0.0.1:7791</span>
        </div>
        <h1>Luna Meeting Room</h1>
        <p>회의록, 결정 대기함, 에이전트 질의를 한 화면에서 다룹니다. 이 UI는 기록과 승인 보조만 수행하며 거래·파라미터를 변경하지 않습니다.</p>
      </div>
      <div className="token-box">
        <label className="meta" htmlFor="meeting-room-token">접근 토큰</label>
        <input
          id="meeting-room-token"
          type="password"
          autoComplete="off"
          aria-describedby="meeting-room-token-help"
          value=${token}
          onChange=${(event) => setToken(event.target.value)}
          placeholder="로컬 무인증이면 비워둠"
        />
        <div id="meeting-room-token-help" className="meta">MEETING_ROOM_TOKEN 설정 시 입력 · 로컬 무인증이면 비워둠</div>
      </div>
    </div>
    <div className="tabs">
      <div className="tab-switcher" role="tablist" aria-label="회의실 화면 전환">
        <button
          id="meeting-tab-daily"
          role="tab"
          className=${tab === 'daily' ? 'active' : ''}
          aria-selected=${tab === 'daily'}
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
        rel="noopener noreferrer"
        aria-label="TeamJay Dashboard 7787 새 창으로 열기"
        title="TeamJay Dashboard 7787 새 창으로 열기"
      >TeamJay Dashboard :7787</a>
    </div>
  `;
}

function MeetingList({ meetings, activeRuns, selectedId, setSelectedId }) {
  const meetingRows = safeArray(meetings);
  const activeRunRows = safeArray(activeRuns);
  const totalCount = meetingRows.length + activeRunRows.length;
  return html`
    <div className="card" role="region" aria-label="회의 목록">
      <h2>회의 목록</h2>
      <div className="card-body list" role="list" aria-live="polite" aria-label=${`회의 목록 ${totalCount}건`}>
        ${activeRunRows.map((run) => html`
          <div className="meeting-list-row" role="listitem">
            <button
              className=${`meeting-item ${String(selectedId) === String(run.id) ? 'active' : ''}`}
              aria-pressed=${String(selectedId) === String(run.id)}
              aria-label=${`실행 중 회의 ${meetingTypeLabel(run.type)} ${meetingStatusLabel(run.status)} 선택`}
              onClick=${() => setSelectedId(run.id)}
            >
              <div className="meeting-title" title=${`회의 타입: ${meetingTypeLabel(run.type)} · 상태: ${meetingStatusLabel(run.status)}`} data-raw-type=${run.type || 'n/a'} data-raw-status=${run.status || 'n/a'}>${meetingTypeLabel(run.type)} · ${meetingStatusLabel(run.status)}</div>
              ${'\n'}
              <div className="meta">${formatTime(run.startedAt)} · 실행 작업</div>
            </button>
          </div>
        `)}
        ${meetingRows.map((meeting) => html`
          <div className="meeting-list-row" role="listitem">
            <button
              className=${`meeting-item ${String(selectedId) === String(meeting.id) ? 'active' : ''}`}
              aria-pressed=${String(selectedId) === String(meeting.id)}
              aria-label=${`회의 #${meeting.id} ${meetingTypeLabel(meeting.type)} ${meetingStatusLabel(meeting.status)} 선택`}
              onClick=${() => setSelectedId(meeting.id)}
            >
              <div className="meeting-title" title=${`회의 타입: ${meetingTypeLabel(meeting.type)}`} data-raw-type=${meeting.type || 'n/a'}>#${meeting.id} · ${meetingTypeLabel(meeting.type)}</div>
              ${'\n'}
              <div className="meta" title=${`상태: ${meetingStatusLabel(meeting.status)}`} data-raw-status=${meeting.status || 'n/a'}>${meetingStatusLabel(meeting.status)} · ${formatTime(meeting.startedAt)}</div>
            </button>
          </div>
        `)}
        ${meetingRows.length === 0 && activeRunRows.length === 0 ? html`<div className="meta">회의 기록 없음</div>` : null}
      </div>
    </div>
  `;
}

function StartMeeting({ token, segments, onStarted, setError }) {
  const types = useMemo(() => meetingTypesForSegments(segments), [segments]);
  const [type, setType] = useState('morning');
  const [useLlm, setUseLlm] = useState(false);
  const [busy, setBusy] = useState(false);
  const startInFlightRef = useRef(false);
  const segmentsReady = safeArray(segments).length > 0;
  const selectedType = types.find((item) => item.value === type) || types[0];
  const selectedTypeDisabled = selectedType?.disabled === true;
  const startBlocked = !segmentsReady || selectedTypeDisabled;
  const startBlockReason = !segmentsReady
    ? '세그먼트 상태 확인 중'
    : (selectedType?.reasonLabel || segmentReasonLabel(selectedType?.reason));
  const startDisabled = busy || startBlocked;
  const startButtonLabel = startBlocked
    ? `${selectedType?.label || type} 시작 불가, 사유 ${startBlockReason}`
    : busy
      ? `${selectedType?.label || type} 시작 중`
      : `${selectedType?.label || type} 시작`;
  async function start() {
    if (startInFlightRef.current || startBlocked) return;
    startInFlightRef.current = true;
    setBusy(true);
    setError('');
    try {
      const payload = await api(token, '/api/meetings/start', {
        method: 'POST',
        body: JSON.stringify({ type, noLlm: !useLlm }),
      });
      if (payload?.run?.id == null) throw new Error(MEETING_START_MALFORMED_MESSAGE);
      onStarted(payload.run);
    } catch (error) {
      setError(error.message);
    } finally {
      startInFlightRef.current = false;
      setBusy(false);
    }
  }
  return html`
    <div className="form-row">
      <label className="meta" htmlFor="meeting-type-select">회의 타입</label>
      <div className="inline">
        <select id="meeting-type-select" title="시작할 회의 타입" aria-describedby="meeting-segment-status" value=${type} onChange=${(event) => setType(event.target.value)}>
          ${types.map((item) => html`
            <option
              value=${item.value}
              disabled=${item.disabled}
              title=${item.disabled ? `${item.label} 비활성: ${item.reasonLabel || segmentReasonLabel(item.reason)}` : item.label}
              aria-label=${item.disabled ? `${item.label} 비활성, 사유 ${item.reasonLabel || segmentReasonLabel(item.reason)}` : item.label}
            >${item.label}</option>
          `)}
        </select>
        <button
          aria-label=${startButtonLabel}
          aria-busy=${busy}
          title=${startBlocked ? `${selectedType?.label || type}는 현재 시작할 수 없습니다: ${startBlockReason}` : `${selectedType?.label || type}를 자문/섀도 회의로 시작합니다.`}
          onClick=${start}
          disabled=${startDisabled}
        >${busy ? '시작 중' : '회의 시작'}</button>
      </div>
      ${startBlocked ? html`<div className="meta" role="status" aria-live="polite">선택한 회의 타입은 현재 시작할 수 없습니다: ${startBlockReason}</div>` : null}
      <${SegmentStatus} segments=${segments} />
      <label className="check" htmlFor="meeting-llm-toggle"><input id="meeting-llm-toggle" type="checkbox" aria-describedby="meeting-llm-mode" checked=${useLlm} onChange=${(event) => setUseLlm(event.target.checked)} /> LLM 발언 사용(비용 가드 적용)</label>
      <div id="meeting-llm-mode" className=${`llm-mode ${useLlm ? 'enabled' : 'disabled'}`} role="status" aria-live="polite" aria-label="LLM 발언 모드">
        현재 모드: ${useLlm ? 'LLM 발언 사용 · 비용 가드 적용' : '결정론 발언 · LLM 비용 0'}
      </div>
    </div>
  `;
}

function Timeline({ detail, catchup, loading }) {
  const minutes = safeArray(detail?.minutes);
  const catchupList = safeArray(catchup);
  const catchupLines = loading
    ? ['회의 상세를 불러오는 중입니다.']
    : (catchupList.length ? catchupList : ['회의를 선택하면 U1 캐치업이 표시됩니다.']);
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
            ${catchupLines.map((line) => html`<div className="catchup-line" role="listitem">${line}</div>${'\n'}`)}
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
              aria-label=${`${minute.seq}번 회의록 · ${agendaLabel(minute.agendaKey || 'session')} · ${roleName(minute.role, minute)} · ${speakerLabel(minute.speaker)}`}
            >
              <div
                className="meeting-title"
                title=${`안건: ${agendaLabel(minute.agendaKey || 'session')} · 발언자: ${speakerLabel(minute.speaker)}`}
                data-raw-agenda=${minute.agendaKey || 'session'}
                data-raw-speaker=${minute.speaker || 'unknown'}
              >${minute.seq}. ${agendaLabel(minute.agendaKey || 'session')} — ${roleName(minute.role, minute)} / ${speakerLabel(minute.speaker)}</div>
              ${'\n'}
              <div className="meta">${formatTime(minute.createdAt)}</div>
              ${'\n'}
              <${MarkdownLite} text=${minute.content} />
            </article>
          `)}
          ${loading ? html`<div className="meta">상세 로딩 중...</div>` : null}
          ${!loading && minutes.length === 0 ? html`<div className="meta">선택된 회의의 회의록이 없습니다.</div>` : null}
        </div>
      </div>
    </div>
  `;
}

function EvidenceDetails({ decision }) {
  const [open, setOpen] = useState(false);
  return html`
    <details onToggle=${(event) => setOpen(event.currentTarget.open)}>
      <summary aria-label=${`결정 #${decision.id} 근거 JSON 보기`}>근거 JSON 보기</summary>
      ${open ? html`<pre>${JSON.stringify(decision.evidence || {}, null, 2)}</pre>` : null}
    </details>
  `;
}

function DecisionCard({ token, decision, onUpdated, setError, setNotice }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const actionInFlightRef = useRef(false);
  const due = dueState(decision.dueAt);
  async function act(action) {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
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
      actionInFlightRef.current = false;
      setBusy('');
    }
  }
  return html`
    <article
      className="decision-card"
      role="listitem"
      aria-label=${`결정 #${decision.id} · ${agendaLabel(decision.agendaKey)} · ${decisionGradeLabel(decision.grade)} · ${decisionStatusLabel(decision.status)} · ${due.label}`}
    >
      <div className="meeting-title" title=${`안건: ${agendaLabel(decision.agendaKey)}`} data-raw-agenda=${decision.agendaKey || 'unknown'}>#${decision.id} · ${agendaLabel(decision.agendaKey)}</div>
      <div
        className="meta decision-state"
        role="group"
        aria-label=${`결정 #${decision.id} 상태 요약: 등급 ${decisionGradeLabel(decision.grade)} · 상태 ${decisionStatusLabel(decision.status)} · 기한 ${due.label}`}
      >
        <span title=${`등급: ${decisionGradeLabel(decision.grade)}`} data-raw-grade=${decision.grade || 'n/a'}>${decisionGradeLabel(decision.grade)}</span>
        <span aria-hidden="true"> · </span>
        <span title=${`상태: ${decisionStatusLabel(decision.status)}`} data-raw-status=${decision.status || 'n/a'}>${decisionStatusLabel(decision.status)}</span>
        <span aria-hidden="true"> · </span>
        <span className=${due.className} title=${due.title} aria-label=${due.title}>${due.label}</span>
      </div>
      <${MarkdownLite} text=${decision.decision} />
      <${EvidenceDetails} decision=${decision} />
      <div className="form-row" style=${{ marginTop: '10px' }}>
        <input value=${note} onChange=${(event) => setNote(event.target.value)} placeholder="감사 메모" aria-label=${`결정 #${decision.id} 감사 메모`} />
        <div className="inline">
          <button aria-label=${busy === 'confirm' ? `결정 #${decision.id} 확정 처리 중` : `결정 #${decision.id} 확정`} aria-busy=${busy === 'confirm'} onClick=${() => act('confirm')} disabled=${Boolean(busy)}>${busy === 'confirm' ? '확정 중' : '확정'}</button>
          <button aria-label=${busy === 'defer' ? `결정 #${decision.id} 보류 처리 중` : `결정 #${decision.id} 보류`} aria-busy=${busy === 'defer'} className="warn" onClick=${() => act('defer')} disabled=${Boolean(busy)}>${busy === 'defer' ? '보류 중' : '보류'}</button>
        </div>
      </div>
    </article>
  `;
}

function Decisions({ token, decisions, onUpdated, setError, setNotice }) {
  const decisionRows = safeArray(decisions);
  return html`
    <div className="card" role="region" aria-label="전체 회의 결정 대기함">
      <h2>전체 결정 대기함</h2>
      <div id="decision-scope-note" className="meta">전체 회의 기준 · 선택 회의 캐치업과 별도</div>
      <div className="card-body list" role="list" aria-live="polite" aria-describedby="decision-scope-note" aria-label=${`전체 회의 기준 마스터 액션 대기 결정 ${decisionRows.length}건`}>
        ${decisionRows.map((decision) => html`<${DecisionCard} key=${decision.id} token=${token} decision=${decision} onUpdated=${onUpdated} setError=${setError} setNotice=${setNotice} />`)}
        ${decisionRows.length === 0 ? html`<div className="meta">전체 회의 기준 마스터 액션 대기 결정 없음</div>` : null}
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
  const baseRequestSeq = useRef(0);
  const detailRequestSeq = useRef(0);
  const hasRunningRun = activeRuns.some((run) => run.status === 'running');
  const pollingIntervalMs = hasRunningRun ? 3000 : 30000;
  const pollingLabel = hasRunningRun
    ? '폴링: 실행 중 회의 감지 · 3초마다 갱신'
    : '폴링: 대기 · 30초마다 갱신';

  function clearDailyRoomData() {
    baseRequestSeq.current += 1;
    detailRequestSeq.current += 1;
    setMeetings([]);
    setActiveRuns([]);
    setSegments([]);
    setPending([]);
    setSelectedId(null);
    setDetail(null);
    setDetailLoading(false);
    setCatchup([]);
    setNotice('');
  }

  async function refreshBase(options = {}) {
    const selectDefault = options.selectDefault === true;
    const requestId = baseRequestSeq.current + 1;
    baseRequestSeq.current = requestId;
    try {
      const list = await api(token, '/api/meetings');
      const pendingPayload = await api(token, '/api/decisions/pending');
      if (baseRequestSeq.current !== requestId) return;
      setMeetings(safeArray(list.meetings));
      setActiveRuns(safeArray(list.activeRuns));
      setSegments(safeArray(list.segments));
      setPending(safeArray(pendingPayload.decisions));
      setError('');
      if ((selectDefault || !selectedId) && (list.activeRuns?.[0] || list.meetings?.[0])) {
        const nextId = (list.activeRuns?.[0] || list.meetings?.[0]).id;
        setSelectedId(nextId);
      }
    } catch (error) {
      if (baseRequestSeq.current !== requestId) return;
      clearDailyRoomData();
      throw error;
    }
  }

  async function refreshSelected(id = selectedId) {
    if (!id) return;
    const requestId = detailRequestSeq.current + 1;
    detailRequestSeq.current = requestId;
    setDetailLoading(true);
    try {
      const payload = await api(token, `/api/meetings/${id}`);
      if (detailRequestSeq.current !== requestId) return;
      if (payload.run) {
        if (payload.run.status === 'completed' && payload.run.sessionId) {
          setSelectedId(payload.run.sessionId);
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
      const catchupPayload = await api(token, `/api/catchup/${id}`);
      if (detailRequestSeq.current !== requestId) return;
      setDetail(payload);
      setCatchup(catchupPayload.lines || []);
      setError('');
    } catch (error) {
      if (detailRequestSeq.current !== requestId) return;
      setDetail(null);
      setCatchup(['회의 상세를 불러오지 못했습니다.']);
      throw error;
    } finally {
      if (detailRequestSeq.current === requestId) setDetailLoading(false);
    }
  }

  useEffect(() => {
    clearDailyRoomData();
    refreshBase({ selectDefault: true }).catch((error) => setError(error.message));
  }, [token]);

  useEffect(() => {
    if (!selectedId) return;
    refreshSelected().catch((error) => setError(error.message));
  }, [selectedId]);

  useEffect(() => {
    const interval = setInterval(() => {
      refreshBase().then(() => refreshSelected()).catch((error) => setError(error.message));
    }, pollingIntervalMs);
    return () => clearInterval(interval);
  }, [activeRuns.map((run) => `${run.id}:${run.status}`).join(','), selectedId, token, pollingIntervalMs]);

  function handleMeetingStarted(run) {
    if (run?.id == null) {
      setError(MEETING_START_MALFORMED_MESSAGE);
      return;
    }
    setSelectedId(run.id);
    refreshBase().catch((error) => setError(error.message));
  }

  function refreshAfterDecisionUpdate() {
    refreshBase().then(() => refreshSelected()).catch((error) => setError(error.message));
  }

  return html`
    ${error ? html`<p className="error" role="alert" aria-live="assertive">${error}</p>` : null}
    ${notice ? html`<p className="notice" role="status" aria-live="polite">${notice}</p>` : null}
    <div className="polling-status" role="status" aria-live="polite" aria-label=${`회의실 폴링 상태: ${pollingLabel}`}>${pollingLabel}</div>
    <div className="grid">
      <div>
        <${StartMeeting} token=${token} segments=${segments} onStarted=${handleMeetingStarted} setError=${setError} />
        <${MeetingList} meetings=${meetings} activeRuns=${activeRuns} selectedId=${selectedId} setSelectedId=${setSelectedId} />
      </div>
      <${Timeline} detail=${detail} catchup=${catchup} loading=${detailLoading} />
      <${Decisions} token=${token} decisions=${pending} onUpdated=${refreshAfterDecisionUpdate} setError=${setError} setNotice=${setNotice} />
    </div>
  `;
}

function AskRoom({ token }) {
  const [agent, setAgent] = useState(() => normalizeAgentName(readSessionValue(ASK_AGENT_STORAGE_KEY, 'luna')));
  const [question, setQuestion] = useState(() => readSessionValue(ASK_QUESTION_STORAGE_KEY, ''));
  const [answer, setAnswer] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const askRequestSeq = useRef(0);
  const askInFlightRef = useRef(false);
  function clearAskResponseState() {
    setError('');
    setAnswer(null);
    setBusy(false);
  }
  function resetAskStateForInputChange() {
    askRequestSeq.current += 1;
    askInFlightRef.current = false;
    clearAskResponseState();
  }
  useEffect(() => {
    askRequestSeq.current += 1;
    askInFlightRef.current = false;
    clearAskResponseState();
  }, [token]);
  function updateAgent(value) {
    const nextAgent = normalizeAgentName(value);
    setAgent(nextAgent);
    writeSessionValue(ASK_AGENT_STORAGE_KEY, nextAgent);
    resetAskStateForInputChange();
  }
  function updateQuestion(value) {
    setQuestion(value);
    writeSessionValue(ASK_QUESTION_STORAGE_KEY, value);
    resetAskStateForInputChange();
  }
  async function ask() {
    if (askInFlightRef.current || !question.trim()) return;
    const requestId = askRequestSeq.current + 1;
    askRequestSeq.current = requestId;
    askInFlightRef.current = true;
    const requestAgent = agent;
    const requestQuestion = question;
    setBusy(true);
    setError('');
    setAnswer(null);
    try {
      const nextAnswer = await api(token, '/api/agents/ask', {
        method: 'POST',
        body: JSON.stringify({ agent: requestAgent, question: requestQuestion }),
      });
      if (askRequestSeq.current === requestId) {
        setAnswer(nextAnswer);
      }
    } catch (error) {
      if (askRequestSeq.current === requestId) {
        setError(error.message);
      }
    } finally {
      if (askRequestSeq.current === requestId) {
        askInFlightRef.current = false;
        setBusy(false);
      }
    }
  }
  function submitAsk(event) {
    event?.preventDefault?.();
    ask();
  }
  function handleQuestionKeyDown(event) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      ask();
    }
  }
  const hasQuestionDraft = Boolean(question.trim());
  const askHelperText = hasQuestionDraft
    ? '질의 보내기를 누르거나 Ctrl/⌘+Enter로 전송할 수 있습니다.'
    : '질문을 입력하면 전송 버튼이 활성화됩니다. Ctrl/⌘+Enter로도 전송할 수 있습니다.';
  const emptyAnswerText = hasQuestionDraft
    ? '아직 응답 없음 · 질의 보내기를 눌러 응답을 확인하세요.'
    : '아직 응답 없음 · 질문을 입력한 뒤 질의 보내기를 누르세요.';
  return html`
    ${error ? html`<p className="error" role="alert" aria-live="assertive">${error}</p>` : null}
    <div className="ask-grid">
      <div className="card">
        <h2 id="meeting-ask-form-title">@멘션 질의</h2>
        ${'\n'}
        <form className="card-body" aria-labelledby="meeting-ask-form-title" onSubmit=${submitAsk}>
          <div className="form-row">
            <label className="meta" htmlFor="meeting-agent-select">에이전트</label>
            ${'\n'}
            <select id="meeting-agent-select" title="질의 대상 에이전트" value=${agent} onChange=${(event) => updateAgent(event.target.value)}>
              ${AGENT_OPTIONS.map((name) => html`<option value=${name}>${agentLabel(name)}</option>${'\n'}`)}
            </select>
          </div>
          ${'\n'}
          <div className="form-row">
            <label className="meta" htmlFor="meeting-agent-question">질문</label>
            ${'\n'}
            <textarea
              id="meeting-agent-question"
              aria-describedby="ask-helper ask-safety-note"
              value=${question}
              onChange=${(event) => updateQuestion(event.target.value)}
              onKeyDown=${handleQuestionKeyDown}
              placeholder="회의실 컨텍스트 기반 자문 질문"
            />
            ${'\n'}
            <div id="ask-helper" className="ask-helper">${askHelperText}</div>
          </div>
          ${'\n'}
          <div id="ask-safety-note" className="ask-safety-note">
            자문 전용 · LLM 호출 비용 가능 · 분당 2회 / 일 20회 한도
          </div>
          ${'\n'}
          <button
            type="submit"
            aria-label=${busy ? `${agentLabel(agent)}에게 자문 질문 진행 중` : `${agentLabel(agent)}에게 자문 질문 보내기`}
            aria-busy=${busy}
            title=${question.trim() ? '선택한 에이전트에게 자문 질문을 보냅니다. Ctrl/⌘+Enter도 사용할 수 있습니다.' : '질문을 입력하면 활성화됩니다.'}
            disabled=${busy || !question.trim()}
          >${busy ? '질의 중' : '질의 보내기'}</button>
        </form>
      </div>
      ${'\n'}
      <div className="card">
        <h2>응답</h2>
        ${'\n'}
        <div className="card-body">
          <div className="answer" role="status" aria-live="polite" aria-busy=${busy} aria-label="에이전트 질의 응답">
            ${busy ? html`<div className="meta">질의 중 · 에이전트 응답을 기다리는 중입니다.</div>` : answer ? html`
              <div className="meta">에이전트 ${agentLabel(answer.agent || agent)} · 응답 방식 ${providerLabel(answer.provider || answer.route?.provider)} · 상태 ${answerStatusLabel(answer.ok)} · 응답: </div>
              ${'\n'}
              <div className="answer-content"><${MarkdownLite} text=${answer.text || answer.error || '응답 없음'} /></div>
            ` : html`<div className="meta">${emptyAnswerText}</div>`}
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
        id="meeting-panel-daily"
        role="tabpanel"
        aria-labelledby="meeting-tab-daily"
        hidden=${tab !== 'daily'}
      >
        ${tab === 'daily' ? html`<${DailyRoom} token=${token} />` : null}
      </section>
      <section
        id="meeting-panel-ask"
        role="tabpanel"
        aria-labelledby="meeting-tab-ask"
        hidden=${tab !== 'ask'}
      >
        <${AskRoom} token=${token} />
      </section>
    </main>
  `;
}

ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);
