export function toKoreanTime(hhmm: string): string {
  const [h, m] = String(hhmm || '').split(':');
  return `${parseInt(h || '0', 10)}시 ${m}분`;
}

export function pickkoEndTime(hhmm: string): string {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  const total = h * 60 + m - 10;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function formatPhone(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return digits;
}

export function maskPhone(phone: string): string {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 11) return `${digits.slice(0, 3)}****${digits.slice(7)}`;
  if (digits.length === 10) return `${digits.slice(0, 3)}***${digits.slice(7)}`;
  if (digits.length > 4) return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  return digits || String(phone || '');
}

export function maskName(name: string): string {
  if (!name) return '';
  const normalized = String(name).trim();
  if (normalized.length <= 1) return normalized;
  return normalized[0] + '*' + normalized[normalized.length - 1];
}
