export function createCompletedBarTracker() {
  const currentBars = new Map();

  function observe(key, bars = []) {
    const byTimestamp = new Map();
    for (const bar of bars) {
      const timestamp = Number(bar?.timestamp);
      if (Number.isFinite(timestamp)) byTimestamp.set(timestamp, bar);
    }

    const ordered = [...byTimestamp.values()]
      .sort((left, right) => Number(left.timestamp) - Number(right.timestamp));
    if (ordered.length === 0) return [];

    const latest = ordered[ordered.length - 1];
    const current = currentBars.get(key);
    if (!current) {
      currentBars.set(key, latest);
      return [];
    }

    if (latest.timestamp < current.timestamp) return [];
    if (latest.timestamp === current.timestamp) {
      currentBars.set(key, latest);
      return [];
    }

    const completed = new Map([[current.timestamp, current]]);
    for (const bar of ordered) {
      if (bar.timestamp >= current.timestamp && bar.timestamp < latest.timestamp) {
        completed.set(bar.timestamp, bar);
      }
    }
    currentBars.set(key, latest);
    return [...completed.values()]
      .sort((left, right) => Number(left.timestamp) - Number(right.timestamp));
  }

  return {
    observe,
    delete: (key) => currentBars.delete(key),
    clear: () => currentBars.clear(),
  };
}
