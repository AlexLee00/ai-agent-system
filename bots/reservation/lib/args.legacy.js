function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, vRaw] = a.slice(2).split('=');
    if (vRaw !== undefined) {
      out[k] = vRaw;
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[k] = next; i++; }
      else                                { out[k] = true; }
    }
  }
  return out;
}

module.exports = { parseArgs };
