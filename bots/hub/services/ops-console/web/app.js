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

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }

  Promise.all([loadOverview(), loadTown()]).finally(openStream);
  setInterval(loadOverview, 30000);
}());
