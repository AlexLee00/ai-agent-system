(function () {
  const ids = ['agentRegistry', 'launchd', 'hubKernel', 'llmCost', 'alarmsTrace'];
  const status = document.getElementById('status');

  function setStatus(text) {
    if (status) status.textContent = text;
  }

  function write(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = JSON.stringify(value, null, 2);
  }

  function render(snapshot) {
    const parts = snapshot && snapshot.parts ? snapshot.parts : {};
    write('agentRegistry', parts.agentRegistry || null);
    write('launchd', parts.launchd || null);
    write('hubKernel', parts.hubKernel || null);
    write('llmCost', parts.llmCost || null);
    write('alarmsTrace', {
      hubAlarms: parts.hubAlarms || null,
      traceTimeline: parts.traceTimeline || null,
    });
    setStatus(snapshot && snapshot.generatedAt ? `updated ${snapshot.generatedAt}` : 'updated');
  }

  async function loadSnapshot() {
    const response = await fetch('/api/os/snapshot', { cache: 'no-store' });
    if (response.status === 404) {
      setStatus('disabled');
      ids.forEach((id) => write(id, { disabled: true }));
      return;
    }
    render(await response.json());
  }

  function openStream() {
    if (typeof EventSource !== 'function') {
      setInterval(loadSnapshot, 10000);
      return;
    }
    const source = new EventSource('/api/os/stream');
    source.addEventListener('hello', () => setStatus('live'));
    source.addEventListener('snapshot', (event) => {
      try {
        render(JSON.parse(event.data));
      } catch {
        loadSnapshot();
      }
    });
    source.onerror = function () {
      source.close();
      setStatus('polling');
      setInterval(loadSnapshot, 10000);
    };
  }

  loadSnapshot().finally(openStream);
}());

