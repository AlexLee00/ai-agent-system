(function () {
  const teamMeta = {
    hub: { emoji: '🧭', name: '허브' },
    ska: { emoji: '🍀', name: '스카' },
    luna: { emoji: '🐺', name: '루나' },
    claude: { emoji: '🤖', name: '클로드' },
    blog: { emoji: '🐦', name: '블로' },
    sigma: { emoji: '🦉', name: '시그마' },
    darwin: { emoji: '🧬', name: '다윈' },
    orchestrator: { emoji: '🎼', name: '오케스트라' },
    write: { emoji: '✍️', name: '라이트' },
    bridge: { emoji: '🌉', name: '브리지' },
  };

  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const clock = document.getElementById('clock');
  const highlights = document.getElementById('highlights');
  const teamGrid = document.getElementById('teamGrid');
  const townList = document.getElementById('townList');
  const generatedAt = document.getElementById('generatedAt');
  const bridgeList = document.getElementById('bridgeList');
  const bridgeDetail = document.getElementById('bridgeDetail');
  const bridgeCount = document.getElementById('bridgeCount');
  const gateList = document.getElementById('gateList');
  const gateCount = document.getElementById('gateCount');
  const replayToggle = document.getElementById('replayToggle');
  const replayWindow = document.getElementById('replayWindow');
  const townMode = document.getElementById('townMode');
  const pushStatus = document.getElementById('pushStatus');
  const pushButton = document.getElementById('pushButton');
  const teamDetailTitle = document.getElementById('teamDetailTitle');
  const teamDetailStatus = document.getElementById('teamDetailStatus');
  const teamStatusStrip = document.getElementById('teamStatusStrip');
  const teamPanels = document.getElementById('teamPanels');
  const memoryCount = document.getElementById('memoryCount');
  const memoryTransitions = document.getElementById('memoryTransitions');
  const teamTownList = document.getElementById('teamTownList');
  const backHomeButton = document.getElementById('backHomeButton');
  const tabs = Array.from(document.querySelectorAll('[data-tab]'));
  const panels = Array.from(document.querySelectorAll('[data-panel]'));
  let replayMode = false;

  function fmtTime(value) {
    const date = value ? new Date(value) : new Date();
    if (!Number.isFinite(date.getTime())) return '--:--';
    return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setStatus(status) {
    const normalized = status === 'bad' ? 'bad' : status === 'warn' ? 'warn' : 'ok';
    statusDot.className = `dot ${normalized === 'ok' ? '' : normalized}`;
    statusText.textContent = normalized === 'ok' ? '정상' : normalized === 'warn' ? '주의' : '이상';
  }

  function renderHighlights(rows) {
    highlights.innerHTML = '';
    (rows || []).slice(0, 3).forEach((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      highlights.appendChild(li);
    });
  }

  function renderTeams(teams) {
    teamGrid.innerHTML = '';
    for (const team of teams || []) {
      const card = document.createElement('article');
      card.className = 'team-card';
      card.dataset.team = team.key;
      card.tabIndex = 0;
      card.style.color = team.color || '#D6D3D1';
      card.innerHTML = `
        <span class="team-chip"></span>
        <div class="team-title">
          <span class="status ${team.status === 'ok' ? '' : team.status}"></span>
          <span class="emoji">${team.emoji || ''}</span>
          <span>${team.name || team.key}</span>
        </div>
        <div class="metrics">
          <span><b>${team.metrics?.[0] || '-'}</b></span>
          <span>${team.metrics?.[1] || ''}</span>
        </div>
        <div class="recent">${team.recent || '최근 활동 없음'}</div>
      `;
      card.addEventListener('click', () => {
        window.location.hash = `#/team/${team.key}`;
      });
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') window.location.hash = `#/team/${team.key}`;
      });
      teamGrid.appendChild(card);
    }
  }

  function renderTown(events, append) {
    if (!append) townList.innerHTML = '';
    for (const event of events || []) {
      const from = teamMeta[event.from] || { emoji: '•', name: event.from || 'unknown' };
      const to = teamMeta[event.to] || { name: event.to || 'unknown' };
      const item = document.createElement('article');
      item.className = `bubble ${event.accent ? 'accent' : ''} ${append ? 'new' : ''}`;
      item.innerHTML = `
        <div class="avatar">${escapeHtml(from.emoji)}</div>
        <div>
          <div class="bubble-meta">${fmtTime(event.ts)} ${escapeHtml(from.name)} <span class="arrow">→</span> ${escapeHtml(to.name)}</div>
          <p>${escapeHtml(event.text || '')}</p>
          <span class="tag">${escapeHtml(event.tag || event.kind || 'event')}</span>
        </div>
      `;
      if (append) townList.prepend(item);
      else townList.appendChild(item);
    }
    while (townList.children.length > 30) townList.removeChild(townList.lastChild);
  }

  function renderBridge(data) {
    bridgeList.innerHTML = '';
    const items = data.items || [];
    bridgeCount.textContent = `${items.length} tasks · pending ${data.counts?.pending || 0}`;
    if (items.length === 0) {
      bridgeList.innerHTML = '<div class="empty-card">브리지 큐가 비어 있습니다.</div>';
      bridgeDetail.textContent = '선택된 브리지 작업이 없습니다.';
      return;
    }
    for (const item of items) {
      const button = document.createElement('button');
      button.className = `bridge-item ${item.status === 'pending' ? 'pending' : ''}`;
      button.innerHTML = `
        <span class="bridge-id">${escapeHtml(item.id)}</span>
        <b>${escapeHtml(item.title || item.id)}</b>
        <small>${escapeHtml(item.status || 'unknown')} · ${escapeHtml(item.verdict || 'pending')} · ${fmtTime(item.ts)}</small>
      `;
      button.addEventListener('click', () => {
        bridgeDetail.textContent = JSON.stringify(item, null, 2);
      });
      bridgeList.appendChild(button);
    }
    bridgeDetail.textContent = JSON.stringify(items[0], null, 2);
  }

  function renderGates(data) {
    gateList.innerHTML = '';
    const gates = data.gates || [];
    gateCount.textContent = `${gates.length} gates · 표시 전용`;
    if (gates.length === 0) {
      gateList.innerHTML = '<div class="empty-card">게이트 상태를 표시할 수 없습니다.</div>';
      return;
    }
    const groups = gates.reduce((acc, gate) => {
      acc[gate.team] = acc[gate.team] || [];
      acc[gate.team].push(gate);
      return acc;
    }, {});
    for (const [team, rows] of Object.entries(groups)) {
      const meta = teamMeta[team] || { emoji: '•', name: team };
      const group = document.createElement('article');
      group.className = 'gate-group';
      group.innerHTML = `<h3>${escapeHtml(meta.emoji)} ${escapeHtml(meta.name)}</h3>`;
      for (const gate of rows) {
        const row = document.createElement('div');
        row.className = `gate-row ${gate.state || 'unset'}`;
        row.innerHTML = `
          <span class="gate-key">${escapeHtml(gate.key)}</span>
          <span class="gate-badge">${escapeHtml(gate.state || 'unset')}</span>
          <small>${escapeHtml(gate.value == null ? 'unset' : gate.value)} · ${escapeHtml(gate.desc || '')}</small>
        `;
        group.appendChild(row);
      }
      gateList.appendChild(group);
    }
  }

  function renderKnowledgeGraph(graph) {
    const nodes = graph?.nodes || [];
    const edges = graph?.edges || [];
    if (!nodes.length) return '<small>지식그래프 노드가 없습니다.</small>';
    const width = 330;
    const height = 180;
    const placed = nodes.slice(0, 24).map((node, index) => {
      const ring = node.kind === 'source' ? 46 : 72;
      const angle = (index / Math.max(1, Math.min(nodes.length, 24))) * Math.PI * 2;
      return {
        ...node,
        x: Math.round(width / 2 + Math.cos(angle) * ring),
        y: Math.round(height / 2 + Math.sin(angle) * ring),
      };
    });
    const byId = new Map(placed.map((node) => [node.id, node]));
    const edgeSvg = edges.slice(0, 36).flatMap((edge) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return [];
      return [`<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" />`];
    }).join('');
    const nodeSvg = placed.map((node) => `
      <g>
        <circle cx="${node.x}" cy="${node.y}" r="${node.kind === 'source' ? 6 : 8}" class="${node.validated ? 'validated' : ''}"></circle>
        <text x="${node.x + 9}" y="${node.y + 4}">${escapeHtml(node.label || node.id).slice(0, 18)}</text>
      </g>
    `).join('');
    return `
      <div class="knowledge-graph">
        <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="sigma knowledge graph">${edgeSvg}${nodeSvg}</svg>
        <small>${nodes.length} nodes · ${edges.length} edges · validated ${nodes.filter((node) => node.validated).length}</small>
      </div>
    `;
  }

  function renderPanelRows(rows) {
    if (!rows || rows.length === 0) return '<small>표시할 데이터가 없습니다.</small>';
    return `<pre>${escapeHtml(JSON.stringify(rows.slice(0, 6), null, 2))}</pre>`;
  }

  function renderTeamDetail(data) {
    const meta = data.team || {};
    teamDetailTitle.textContent = `${meta.emoji || ''} ${meta.name || meta.id || '팀'} 상세`;
    teamDetailStatus.textContent = data.status || 'unknown';
    teamStatusStrip.innerHTML = `
      <span>잡 ${data.jobs?.total || 0}/${Math.max(0, (data.jobs?.total || 0) - (data.jobs?.failed || 0))}</span>
      <span>실패 ${data.jobs?.failed || 0}</span>
      <span>MCP ${data.mcp?.ok === false ? 'CHECK' : 'OK'}</span>
    `;
    teamPanels.innerHTML = '';
    for (const item of data.panels || []) {
      const article = document.createElement('article');
      article.className = 'detail-panel';
      article.innerHTML = `
        <h3>${escapeHtml(item.title || 'panel')}</h3>
        ${item.kind === 'knowledgeGraph' ? renderKnowledgeGraph(item.graph) : renderPanelRows(item.rows || [])}
      `;
      teamPanels.appendChild(article);
    }
    memoryTransitions.innerHTML = '';
    const transitions = data.memoryTransitions || [];
    memoryCount.textContent = `${transitions.length} events`;
    if (transitions.length === 0) {
      memoryTransitions.innerHTML = '<div class="empty-card">기억 전이 이벤트가 없습니다.</div>';
    } else {
      for (const item of transitions) {
        const bubble = document.createElement('article');
        bubble.className = 'memory-bubble';
        bubble.innerHTML = `
          <b>${escapeHtml(item.title || 'memory')}</b>
          <p>${escapeHtml(item.action || 'audit')} · applied=${item.applied === true} · ${escapeHtml(item.reasoning || '')}</p>
          <small>${fmtTime(item.ts)} · ${escapeHtml(item.classifier || 'sigma')}</small>
        `;
        memoryTransitions.appendChild(bubble);
      }
    }
    renderTownInto(teamTownList, data.townSquare || [], false);
  }

  function renderTownInto(target, events, append) {
    if (!append) target.innerHTML = '';
    for (const event of events || []) {
      const from = teamMeta[event.from] || { emoji: '•', name: event.from || 'unknown' };
      const to = teamMeta[event.to] || { name: event.to || 'unknown' };
      const item = document.createElement('article');
      item.className = `bubble ${event.accent ? 'accent' : ''} ${append ? 'new' : ''}`;
      item.innerHTML = `
        <div class="avatar">${escapeHtml(from.emoji)}</div>
        <div>
          <div class="bubble-meta">${fmtTime(event.ts)} ${escapeHtml(from.name)} <span class="arrow">→</span> ${escapeHtml(to.name)}</div>
          <p>${escapeHtml(event.text || '')}</p>
          <span class="tag">${escapeHtml(event.tag || event.kind || 'event')}</span>
        </div>
      `;
      if (append) target.prepend(item);
      else target.appendChild(item);
    }
    while (target.children.length > 30) target.removeChild(target.lastChild);
  }

  async function loadOverview() {
    const response = await fetch('/api/overview', { cache: 'no-store' });
    const data = await response.json();
    setStatus(data.status);
    clock.textContent = data.clock || fmtTime();
    generatedAt.textContent = data.generatedAt ? `updated ${fmtTime(data.generatedAt)}` : 'read-only';
    renderHighlights(data.highlights);
    renderTeams(data.teams);
    loadHighlight().catch(() => {});
  }

  async function loadTown() {
    const response = await fetch('/api/townsquare?limit=8', { cache: 'no-store' });
    const data = await response.json();
    renderTown(data.events || [], false);
    if (townMode) townMode.textContent = 'SSE live';
  }

  async function loadBridge() {
    const response = await fetch('/api/bridge', { cache: 'no-store' });
    renderBridge(await response.json());
  }

  async function loadGates() {
    const response = await fetch('/api/gates', { cache: 'no-store' });
    renderGates(await response.json());
  }

  async function loadHighlight() {
    const response = await fetch('/api/highlight', { cache: 'no-store' });
    const data = await response.json();
    if (data.ok) renderHighlights(data.lines || []);
  }

  async function loadReplay() {
    const hours = Number(replayWindow?.value || 24) || 24;
    const to = new Date();
    const from = new Date(to.getTime() - hours * 60 * 60 * 1000);
    const params = new URLSearchParams({
      replay: '1',
      limit: '30',
      from: from.toISOString(),
      to: to.toISOString(),
    });
    const response = await fetch(`/api/townsquare?${params.toString()}`, { cache: 'no-store' });
    const data = await response.json();
    renderTown((data.events || []).slice().reverse(), false);
    if (townMode) townMode.textContent = `replay ${hours}h`;
  }

  async function loadTeamDetail(teamId) {
    const response = await fetch(`/api/team/${encodeURIComponent(teamId)}`, { cache: 'no-store' });
    renderTeamDetail(await response.json());
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i += 1) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  async function enablePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      pushStatus.textContent = '이 브라우저는 Web Push를 지원하지 않습니다.';
      return;
    }
    const vapid = await (await fetch('/api/push/vapid-public', { cache: 'no-store' })).json();
    if (!vapid.publicKey) {
      pushStatus.textContent = 'VAPID public key가 설정되지 않았습니다. 마스터 setenv 후 활성화됩니다.';
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      pushStatus.textContent = `알림 권한 상태: ${permission}`;
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapid.publicKey),
    });
    const stored = await (await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription }),
    })).json();
    pushStatus.textContent = stored.ok ? `푸시 구독 저장 완료 · ${stored.count}개` : `푸시 구독 실패: ${stored.error || 'unknown'}`;
  }

  function switchTab(tab) {
    for (const button of tabs) button.classList.toggle('active', button.dataset.tab === tab);
    for (const panel of panels) panel.hidden = panel.dataset.panel !== tab;
    if (tab === 'bridge') loadBridge().catch(() => {});
    if (tab === 'gates') loadGates().catch(() => {});
    if (tab !== 'team' && window.location.hash.startsWith('#/team/')) window.location.hash = `#/${tab}`;
  }

  function routeFromHash() {
    const hash = window.location.hash || '#/home';
    const teamMatch = hash.match(/^#\/team\/([^/]+)$/);
    if (teamMatch) {
      const teamId = decodeURIComponent(teamMatch[1]);
      for (const button of tabs) button.classList.remove('active');
      for (const panel of panels) panel.hidden = panel.dataset.panel !== 'team';
      loadTeamDetail(teamId).catch(() => {
        teamDetailTitle.textContent = '팀 상세 오류';
        teamDetailStatus.textContent = 'error';
      });
      return;
    }
    const tab = hash.replace(/^#\//, '') || 'home';
    switchTab(['home', 'town', 'gates', 'bridge', 'settings'].includes(tab) ? tab : 'home');
  }

  function openStream() {
    if (typeof EventSource !== 'function') {
      setInterval(loadTown, 10000);
      return;
    }
    const source = new EventSource('/api/stream');
    source.addEventListener('townsquare', (event) => {
      if (replayMode) return;
      try {
        renderTown([JSON.parse(event.data)], true);
      } catch {
        loadTown();
      }
    });
    source.onerror = function () {
      source.close();
      setInterval(loadTown, 10000);
    };
  }

  for (const button of tabs) button.addEventListener('click', () => {
    window.location.hash = `#/${button.dataset.tab}`;
  });
  if (backHomeButton) backHomeButton.addEventListener('click', () => {
    window.location.hash = '#/home';
  });
  if (replayToggle) replayToggle.addEventListener('click', () => {
    replayMode = !replayMode;
    replayToggle.classList.toggle('active', replayMode);
    if (replayMode) loadReplay().catch(() => {});
    else loadTown().catch(() => {});
  });
  if (replayWindow) replayWindow.addEventListener('change', () => {
    if (replayMode) loadReplay().catch(() => {});
  });
  window.addEventListener('hashchange', routeFromHash);
  if (pushButton) pushButton.addEventListener('click', () => enablePush().catch((error) => {
    pushStatus.textContent = `푸시 구독 오류: ${String(error.message || error).slice(0, 120)}`;
  }));

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }

  Promise.all([loadOverview(), loadTown(), loadGates(), loadBridge()]).finally(openStream);
  routeFromHash();
  setInterval(loadOverview, 30000);
  setInterval(loadBridge, 15000);
  setInterval(loadGates, 30000);
}());
