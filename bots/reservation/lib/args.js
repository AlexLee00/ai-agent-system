function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, vRaw] = a.slice(2).split('=');
    const v = vRaw ?? argv[i + 1];
    if (vRaw === undefined) i++;
    out[k] = v;
  }
  return out;
}

module.exports = { parseArgs };
