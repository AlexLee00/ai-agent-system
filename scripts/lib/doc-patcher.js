/**
 * doc-patcher.js - HANDOFF.md·DEV_SUMMARY.md·MEMORY.md·WORK_HISTORY·coding-guide·RESEARCH_JOURNAL 자동 패치
 *
 * 멱등성 보장: 각 패치 전 <!-- session-close:DATE:SLUG --> 마커 확인,
 * 이미 있으면 스킵 (재실행 safe).
 *
 * 폴백 전략: 삽입 마커가 없어도 대체 위치에 자동 삽입 (error 대신 patched)
 */

const fs = require('fs');
const path = require('path');

/**
 * @param {string} botId
 * @param {object} note - { title, type, items, files, date, slug, journalEntry? }
 * @param {object} opts
 *   @param {string} opts.contextDir       - 절대 경로 (bots/reservation/context)
 *   @param {string} opts.claudeMemoryDir  - 절대 경로 (~/.claude/.../memory)
 *   @param {string} [opts.docsDir]        - 절대 경로 (docs/)
 *   @param {boolean} [opts.dryRun]        - true면 변경 없이 diff만 출력
 * @returns {Array<{file: string, status: 'patched'|'skipped'|'error'|'dry', detail: string}>}
 */
function patchDocs(botId, note, opts) {
  const { contextDir, claudeMemoryDir, docsDir, dryRun = false } = opts;
  const results = [];

  // 1. HANDOFF.md 패치
  const handoffPath = path.join(contextDir, 'HANDOFF.md');
  results.push(patchHandoff(handoffPath, note, dryRun));

  // 2. DEV_SUMMARY.md 패치
  const devSummaryPath = path.join(contextDir, 'DEV_SUMMARY.md');
  results.push(patchDevSummary(devSummaryPath, note, dryRun));

  // 3. MEMORY.md 패치
  const memoryPath = path.join(claudeMemoryDir, 'MEMORY.md');
  results.push(patchMemory(memoryPath, note, dryRun));

  // 4. WORK_HISTORY.md 패치 (docs/ 또는 memory/ 경유)
  const workHistoryPath = docsDir
    ? path.join(docsDir, 'WORK_HISTORY.md')
    : path.join(claudeMemoryDir, 'WORK_HISTORY.md');
  results.push(patchWorkHistory(workHistoryPath, note, dryRun));

  // 5. coding-guide.md 변경 이력 패치
  const codingGuidePath = docsDir
    ? path.join(docsDir, 'coding-guide.md')
    : path.join(claudeMemoryDir, 'coding-guide.md');
  results.push(patchCodingGuide(codingGuidePath, note, dryRun));

  // 6. RESEARCH_JOURNAL.md 패치 (journalEntry 있을 때만)
  if (note.journalEntry) {
    const devJournalPath = path.join(claudeMemoryDir, 'RESEARCH_JOURNAL.md');
    results.push(patchDevJournal(devJournalPath, note, dryRun));
  }

  return results;
}

// ─── HANDOFF.md 패치 ─────────────────────────────────────────────────────
function patchHandoff(filePath, note, dryRun) {
  const { title, type, items, files, date, slug } = note;
  const markerStart = `<!-- session-close:${date}:${slug} -->`;
  const markerEnd   = `<!-- session-close:${date}:${slug}:end -->`;

  if (!fs.existsSync(filePath)) {
    return { file: 'HANDOFF.md', status: 'error', detail: '파일 없음' };
  }

  let content = fs.readFileSync(filePath, 'utf-8');

  if (content.includes(markerStart)) {
    return { file: 'HANDOFF.md', status: 'skipped', detail: '이미 패치됨' };
  }

  const typeEmoji = { feature: '✨', fix: '🔧', refactor: '♻️', ops: '⚙️' }[type] || '📝';
  const itemLines = items.map(i => `- ${i}`).join('\n');
  const filesLine = files.length > 0
    ? `\n- 관련 파일: ${files.map(f => `\`${f}\``).join(', ')}`
    : '';

  const block = `${markerStart}\n#### ${date} ${typeEmoji} ${title}\n${itemLines}${filesLine}\n${markerEnd}\n\n`;

  if (dryRun) {
    console.log('\n[dry-run] HANDOFF.md 삽입 예정:\n' + block);
    return { file: 'HANDOFF.md', status: 'dry', detail: '삽입 예정' };
  }

  // 1순위: bug-tracker 마커
  if (content.includes('<!-- bug-tracker:maintenance:start -->')) {
    content = content.replace('<!-- bug-tracker:maintenance:start -->', block + '<!-- bug-tracker:maintenance:start -->');
    fs.writeFileSync(filePath, content);
    return { file: 'HANDOFF.md', status: 'patched', detail: 'bug-tracker 마커 위에 삽입' };
  }

  // 2순위: "## 다음 작업" / "## 트러블" / "## launchd" 섹션 앞
  const fallbackHeaders = ['## 다음 작업', '## 트러블슈팅', '## launchd', '## 트러블'];
  for (const header of fallbackHeaders) {
    if (content.includes(header)) {
      content = content.replace(header, block + header);
      fs.writeFileSync(filePath, content);
      return { file: 'HANDOFF.md', status: 'patched', detail: `"${header}" 섹션 위에 삽입 (폴백)` };
    }
  }

  // 3순위: 파일 끝에 추가
  content = content.trimEnd() + '\n\n---\n\n## 최근 변경\n\n' + block;
  fs.writeFileSync(filePath, content);
  return { file: 'HANDOFF.md', status: 'patched', detail: '파일 끝에 추가 (폴백)' };
}

// ─── DEV_SUMMARY.md 패치 ─────────────────────────────────────────────────
function patchDevSummary(filePath, note, dryRun) {
  const { title, items, date, slug } = note;
  const markerComment = `<!-- session-close:${date}:${slug} -->`;

  if (!fs.existsSync(filePath)) {
    return { file: 'DEV_SUMMARY.md', status: 'error', detail: '파일 없음' };
  }

  let content = fs.readFileSync(filePath, 'utf-8');

  if (content.includes(markerComment)) {
    return { file: 'DEV_SUMMARY.md', status: 'skipped', detail: '이미 패치됨' };
  }

  const resultSummary = items.length > 1
    ? `${items[0]} 외 ${items.length - 1}건`
    : items[0] || title;

  const newRow = `| ${date} | **${title}** | ${resultSummary} |`;

  if (dryRun) {
    console.log('\n[dry-run] DEV_SUMMARY.md 삽입 예정:\n' + newRow);
    return { file: 'DEV_SUMMARY.md', status: 'dry', detail: '삽입 예정' };
  }

  // 1순위: 기존 타임라인 테이블 마지막 행 뒤
  const lines = content.split('\n');
  let lastTableRowIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\| 20\d\d-/.test(lines[i])) lastTableRowIdx = i;
  }

  if (lastTableRowIdx !== -1) {
    lines.splice(lastTableRowIdx + 1, 0, newRow, markerComment);
    fs.writeFileSync(filePath, lines.join('\n'));
    return { file: 'DEV_SUMMARY.md', status: 'patched', detail: `타임라인 행 ${lastTableRowIdx + 1} 뒤 삽입` };
  }

  // 2순위: 타임라인 테이블 없으면 파일 끝에 "## 변경 이력" 섹션 생성
  const historySection = `\n\n## 변경 이력\n\n| 날짜 | 제목 | 내용 |\n|------|------|------|\n${newRow}\n${markerComment}\n`;
  fs.writeFileSync(filePath, content.trimEnd() + historySection);
  return { file: 'DEV_SUMMARY.md', status: 'patched', detail: '변경 이력 섹션 신규 생성 (폴백)' };
}

// ─── MEMORY.md 패치 ──────────────────────────────────────────────────────
function patchMemory(filePath, note, dryRun) {
  const { title, items, date, slug } = note;
  const markerComment = `<!-- session-close:${date}:${slug} -->`;

  if (!fs.existsSync(filePath)) {
    return { file: 'MEMORY.md', status: 'error', detail: '파일 없음' };
  }

  let content = fs.readFileSync(filePath, 'utf-8');

  if (content.includes(markerComment)) {
    return { file: 'MEMORY.md', status: 'skipped', detail: '이미 패치됨' };
  }

  const itemsSummary = items.join(' | ');
  const newLine = `- **완료 (${date})**: ${title} — ${itemsSummary}\n${markerComment}\n`;

  if (dryRun) {
    console.log('\n[dry-run] MEMORY.md 삽입 예정:\n' + newLine);
    return { file: 'MEMORY.md', status: 'dry', detail: '삽입 예정' };
  }

  // 1순위: "- **다음 작업**:" 줄 바로 위
  if (content.includes('- **다음 작업**:')) {
    content = content.replace('- **다음 작업**:', newLine + '- **다음 작업**:');
    fs.writeFileSync(filePath, content);
    return { file: 'MEMORY.md', status: 'patched', detail: '다음 작업 줄 위에 삽입' };
  }

  // 2순위: "→ 상세 백로그:" 줄 바로 위
  const fallbackMarkers = ['→ 상세 백로그:', '→ 오케스트레이터', '## API 현황', '## 개발 경로'];
  for (const marker of fallbackMarkers) {
    if (content.includes(marker)) {
      content = content.replace(marker, newLine + marker);
      fs.writeFileSync(filePath, content);
      return { file: 'MEMORY.md', status: 'patched', detail: `"${marker.slice(0,15)}" 위에 삽입 (폴백)` };
    }
  }

  // 3순위: 파일 끝 추가
  content = content.trimEnd() + '\n\n' + newLine;
  fs.writeFileSync(filePath, content);
  return { file: 'MEMORY.md', status: 'patched', detail: '파일 끝에 추가 (폴백)' };
}

// ─── WORK_HISTORY.md 패치 ────────────────────────────────────────────────
function patchWorkHistory(filePath, note, dryRun) {
  const { title, type, items, date, slug } = note;
  const marker = `<!-- session-close:${date}:${slug} -->`;

  if (!fs.existsSync(filePath)) {
    return { file: 'WORK_HISTORY.md', status: 'error', detail: '파일 없음' };
  }

  let content = fs.readFileSync(filePath, 'utf-8');

  if (content.includes(marker)) {
    return { file: 'WORK_HISTORY.md', status: 'skipped', detail: '이미 패치됨' };
  }

  const typeEmoji = { feature: '✨', fix: '🔧', refactor: '♻️', ops: '⚙️', config: '⚙️' }[type] || '📝';
  const itemLines = items.map(i => `- ${i}`).join('\n');
  const newBlock = `\n### ${typeEmoji} ${title}\n${itemLines}\n${marker}\n`;
  const dateHeader = `## ${date}`;

  if (dryRun) {
    console.log('\n[dry-run] WORK_HISTORY.md 삽입 예정:\n' + newBlock);
    return { file: 'WORK_HISTORY.md', status: 'dry', detail: `${dateHeader} 섹션에 추가` };
  }

  if (content.includes(dateHeader)) {
    const nextSection = content.indexOf('\n## ', content.indexOf(dateHeader) + 1);
    if (nextSection === -1) {
      content = content.trimEnd() + newBlock;
    } else {
      content = content.slice(0, nextSection) + newBlock + content.slice(nextSection);
    }
  } else {
    const firstSection = content.indexOf('\n## ');
    const newSection = `\n${dateHeader}${newBlock}`;
    if (firstSection === -1) {
      content = content.trimEnd() + '\n' + newSection;
    } else {
      content = content.slice(0, firstSection) + '\n' + newSection + content.slice(firstSection);
    }
  }

  fs.writeFileSync(filePath, content);
  return { file: 'WORK_HISTORY.md', status: 'patched', detail: `${dateHeader} 섹션에 추가` };
}

// ─── coding-guide.md 변경 이력 패치 ─────────────────────────────────────
function patchCodingGuide(filePath, note, dryRun) {
  const { title, items, date, slug } = note;
  const marker = `<!-- session-close:${date}:${slug} -->`;

  if (!fs.existsSync(filePath)) {
    return { file: 'coding-guide.md', status: 'error', detail: '파일 없음' };
  }

  let content = fs.readFileSync(filePath, 'utf-8');

  if (content.includes(marker)) {
    return { file: 'coding-guide.md', status: 'skipped', detail: '이미 패치됨' };
  }

  content = content.replace(
    /> 마지막 업데이트: \d{4}-\d{2}-\d{2}/,
    `> 마지막 업데이트: ${date}`
  );

  const tableMarker = '| 날짜 | 내용 |';
  if (!content.includes(tableMarker)) {
    return { file: 'coding-guide.md', status: 'error', detail: '변경 이력 테이블 없음' };
  }

  const summary = items.length > 1 ? `${items[0]} 외 ${items.length - 1}건` : items[0] || title;
  const newRow = `| ${date} | **${title}** — ${summary} |\n${marker}`;

  const lines = content.split('\n');
  let lastTableRowIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\| 20\d\d-/.test(lines[i])) lastTableRowIdx = i;
  }

  if (lastTableRowIdx === -1) {
    const headerIdx = lines.findIndex(l => l.includes(tableMarker));
    lines.splice(headerIdx + 2, 0, newRow);
  } else {
    lines.splice(lastTableRowIdx + 1, 0, newRow);
  }

  if (dryRun) {
    console.log('\n[dry-run] coding-guide.md 변경 이력 추가:\n' + newRow);
    return { file: 'coding-guide.md', status: 'dry', detail: '변경 이력 테이블에 행 추가' };
  }

  fs.writeFileSync(filePath, lines.join('\n'));
  return { file: 'coding-guide.md', status: 'patched', detail: '변경 이력 테이블 + 날짜 갱신' };
}

// ─── RESEARCH_JOURNAL.md 패치 ────────────────────────────────────────────
/**
 * RESEARCH_JOURNAL.md에 결정사항(DEC-NNN) 엔트리 추가
 * note.journalEntry: 사전 포맷된 저널 텍스트 (없으면 스킵)
 */
function patchDevJournal(filePath, note, dryRun) {
  const { date, slug, journalEntry } = note;
  const marker = `<!-- session-close:${date}:${slug}:journal -->`;

  if (!journalEntry) {
    return { file: 'RESEARCH_JOURNAL.md', status: 'skipped', detail: 'journalEntry 없음' };
  }

  if (!fs.existsSync(filePath)) {
    return { file: 'RESEARCH_JOURNAL.md', status: 'error', detail: '파일 없음' };
  }

  let content = fs.readFileSync(filePath, 'utf-8');

  if (content.includes(marker)) {
    return { file: 'RESEARCH_JOURNAL.md', status: 'skipped', detail: '이미 패치됨' };
  }

  // DEC 번호 자동 증가
  const decMatches = [...content.matchAll(/### DEC-(\d+)/g)];
  const nextDecNum = decMatches.length > 0
    ? Math.max(...decMatches.map(m => parseInt(m[1]))) + 1
    : 1;
  const decId = String(nextDecNum).padStart(3, '0');

  // 첫 줄이 "### DEC-" 이면 번호 자동 교체, 아니면 그대로 사용
  let entryText = journalEntry.trim();
  if (!entryText.startsWith('### DEC-')) {
    entryText = `### DEC-${decId} | ${entryText}`;
  } else {
    entryText = entryText.replace(/^### DEC-\d+/, `### DEC-${decId}`);
  }

  const block = `\n---\n\n${entryText}\n\n${marker}\n`;

  if (dryRun) {
    console.log('\n[dry-run] RESEARCH_JOURNAL.md 삽입 예정:\n' + block);
    return { file: 'RESEARCH_JOURNAL.md', status: 'dry', detail: `DEC-${decId} 엔트리 추가 예정` };
  }

  // 삽입 위치: "_최초 작성:" 줄 바로 앞 (파일 푸터)
  const footerMarker = '_최초 작성:';
  if (content.includes(footerMarker)) {
    content = content.replace(footerMarker, block + '\n' + footerMarker);
  } else {
    content = content.trimEnd() + block;
  }

  fs.writeFileSync(filePath, content);
  return { file: 'RESEARCH_JOURNAL.md', status: 'patched', detail: `DEC-${decId} 엔트리 추가` };
}

module.exports = { patchDocs, patchDevJournal };
