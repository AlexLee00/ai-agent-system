// @ts-nocheck

export function parseUniverseCliFlags(args = []) {
  const values = Array.isArray(args) ? args : [];
  const symbolArg = values.find((arg) => String(arg).startsWith('--symbols='));

  return {
    symbols: symbolArg
      ? String(symbolArg).split('=')[1].split(',').map((symbol) => symbol.trim()).filter(Boolean)
      : null,
    force: values.includes('--force'),
    noDynamic: values.includes('--no-dynamic'),
    researchOnly: values.includes('--research-only'),
  };
}
