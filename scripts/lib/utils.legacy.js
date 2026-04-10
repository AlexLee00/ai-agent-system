/**
 * utils.js - 공유 유틸리티 함수
 */

function log(msg) {
  const t = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`[${t}] ${msg}`);
}

function expandHome(p) {
  return p.startsWith('~') ? p.replace('~', process.env.HOME) : p;
}

// files 항목을 { src, dest } 형태로 정규화
// 문자열 "FOO.md"     → { src: "FOO.md", dest: "FOO.md" }
// 객체  { src, dest } → 그대로
function normalizeFiles(files) {
  return files.map(f => (typeof f === 'string' ? { src: f, dest: f } : f));
}

module.exports = { log, expandHome, normalizeFiles };
