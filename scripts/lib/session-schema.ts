// @ts-nocheck
/**
 * session-schema.js - 세션 노트 스키마 정의 + CLI arg 파싱
 *
 * SessionNote 스키마:
 * {
 *   title:   string,          --title="..."
 *   type:    'feature'|'fix'|'refactor'|'ops', --type=feature
 *   items:   string[],        --items="A|B|C"
 *   files:   string[],        --files="a.js,b.js"
 *   date:    string,          자동: KST today (YYYY-MM-DD)
 *   slug:    string,          자동: title 소문자 공백→하이픈 30자 truncate
 * }
 */

/** KST 기준 오늘 날짜 YYYY-MM-DD */
function todayKST() {
  return new Date().toLocaleDateString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).replace(/\. /g, '-').replace('.', '').trim();
}

/** title → slug (소문자, 공백→하이픈, 특수문자 제거, 30자 truncate) */
function makeSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^\w\s가-힣]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .substring(0, 30);
}

/**
 * process.argv.slice(2) 파싱
 * @returns {{ botId: string|null, note: object, flags: object }}
 */
function parseArgs(argv) {
  const get = (prefix) => argv.find(a => a.startsWith(prefix))?.split('=').slice(1).join('=') || null;

  const botId      = get('--bot=');
  const title      = get('--title=');
  const type       = get('--type=') || 'feature';
  const itemsRaw   = get('--items=');
  const filesRaw   = get('--files=');
  const date       = get('--date=') || todayKST();

  const items = itemsRaw ? itemsRaw.split('|').map(s => s.trim()).filter(Boolean) : [];
  const files = filesRaw ? filesRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const slug  = title ? makeSlug(title) : '';

  const journalEntry = get('--journal-entry=') || null;
  const note = { title, type, items, files, date, slug, journalEntry };

  const flags = {
    deployOnly: argv.includes('--deploy-only'),
    dryRun:     argv.includes('--dry-run'),
    all:        argv.includes('--all'),
    list:       argv.includes('--list'),
    sync:       argv.includes('--sync'),
    gitCommit:  argv.includes('--git-commit'),
    auto:       argv.includes('--auto'),
  };

  return { botId, note, flags };
}

/** @param {object} note @throws {Error} 필수 필드 누락 시 */
function validateNote(note) {
  if (!note.title) throw new Error('--title 필수');
  if (!['feature', 'fix', 'refactor', 'ops'].includes(note.type)) {
    throw new Error(`--type 오류: ${note.type} (허용: feature|fix|refactor|ops)`);
  }
  if (note.items.length === 0) throw new Error('--items 필수 (파이프 | 구분)');
}

module.exports = { parseArgs, validateNote, todayKST, makeSlug };
