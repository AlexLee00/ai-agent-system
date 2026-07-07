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
  const pushStatus = document.getElementById('pushStatus');
  const pushButton = document.getElementById('pushButton');
  const tabs = Array.from(document.querySelectorAll('[data-tab]'));
  const panels = Array.from(document.querySelectorAll('[data-panel]'));

  function fmtTime(value) {
    const date = value ? new Date(value) : new Date();
    if (!Number.isFinite(date.getTime())) return '--:--';
    return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
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
        <div class="avatar">${from.emoji}</div>
        <div>
          <div class="bubble-meta">${fmtTime(event.ts)} ${from.name} <span class="arrow">→</span> ${to.name}</div>
          <p>${event.text || ''}</p>
          <span class="tag">${event.tag || event.kind || 'event'}</span>
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
        <span class="bridge-id">${item.id}</span>
        <b>${item.title || item.id}</b>
        <small>${item.status || 'unknown'} · ${item.verdict || 'pending'} · ${fmtTime(item.ts)}</small>
      `;
      button.addEventListener('click', () => {
        bridgeDetail.textContent = JSON.stringify(item, null, 2);
      });
      bridgeList.appendChild(button);
    }
    bridgeDetail.textContent = JSON.stringify(items[0], null, 2);
  }

  async function loadOverview() {
    const response = await fetch('/api/overview', { cache: 'no-store' });
    const data = await response.json();
    setStatus(data.status);
    clock.textContent = data.clock || fmtTime();
    generatedAt.textContent = data.generatedAt ? `updated ${fmtTime(data.generatedAt)}` : 'read-only';
    renderHighlights(data.highlights);
    renderTeams(data.teams);
  }

  async function loadTown() {
    const response = await fetch('/api/townsquare?limit=8', { cache: 'no-store' });
    const data = await response.json();
    renderTown(data.events || [], false);
  }

  async function loadBridge() {
    const response = await fetch('/api/bridge', { cache: 'no-store' });
    renderBridge(await response.json());
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
  }

  function openStream() {
    if (typeof EventSource !== 'function') {
      setInterval(loadTown, 10000);
      return;
    }
    const source = new EventSource('/api/stream');
    source.addEventListener('townsquare', (event) => {
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

  for (const button of tabs) button.addEventListener('click', () => switchTab(button.dataset.tab));
  if (pushButton) pushButton.addEventListener('click', () => enablePush().catch((error) => {
    pushStatus.textContent = `푸시 구독 오류: ${String(error.message || error).slice(0, 120)}`;
  }));

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }

  Promise.all([loadOverview(), loadTown(), loadBridge()]).finally(openStream);
  setInterval(loadOverview, 30000);
  setInterval(loadBridge, 15000);
}());
