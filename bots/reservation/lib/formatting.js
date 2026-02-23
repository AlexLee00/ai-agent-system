function toKoreanTime(hhmm) {
  const [h, m] = hhmm.split(':');
  return `${parseInt(h, 10)}시 ${m}분`;
}

function pickkoEndTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m - 10;
  return `${String(Math.floor(total / 60)).padStart(2,'0')}:${String(total % 60).padStart(2,'0')}`;
}

function formatPhone(raw) {
  const d = raw.replace(/\D/g, '');
  return d.length === 11 ? `${d.slice(0,3)}-${d.slice(3,7)}-${d.slice(7)}`
       : d.length === 10 ? `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}` : d;
}

module.exports = { toKoreanTime, pickkoEndTime, formatPhone };
