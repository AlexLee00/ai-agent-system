/**
 * doc-patcher.js - HANDOFF.md·DEV_SUMMARY.md·MEMORY.md 자동 패치
 *
 * 멱등성 보장: 각 패치 전 <!-- session-close:DATE:SLUG --> 마커 확인,
 * 이미 있으면 스킵 (재실행 safe).
 */

const fs = require('fs');
const path = require('path');

/**
 * @param {string} botId
 * @param {object} note - { title, type, items, files, date, slug }
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

  // 4. work-history.md 패치 (docs/ 또는 symlink 경유)
  const workHistoryPath = docsDir
    ? path.join(docsDir, 'work-history.md')
    : path.join(claudeMemoryDir, 'work-history.md');
  results.push(patchWorkHistory(workHistoryPath, note, dryRun));

  // 5. coding-guide.md 변경 이력 패치
  const codingGuidePath = docsDir
    ? path.join(docsDir, 'coding-guide.md')
    : path.join(claudeMemoryDir, 'coding-guide.md');
  results.push(patchCodingGuide(codingGuidePath, note, dryRun));

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

  // 멱등성: 이미 패치됨
  if (content.includes(markerStart)) {
    return { file: 'HANDOFF.md', status: 'skipped', detail: '이미 패치됨' };
  }

  // 삽입 위치: <!-- bug-tracker:maintenance:start --> 바로 위
  const insertBefore = '<!-- bug-tracker:maintenance:start -->';
  if (!content.includes(insertBefore)) {
    return { file: 'HANDOFF.md', status: 'error', detail: `삽입 마커 없음: ${insertBefore}` };
  }

  const typeEmoji = { feature: '✨', fix: '🔧', refactor: '♻️', ops: '⚙️' }[type] || '📝';
  const itemLines = items.map(i => `- ${i}`).join('\n');
  const filesLine = files.length > 0
    ? `\n- 관련 파일: ${files.map(f => `\`${f}\``).join(', ')}`
    : '';

  const block = `${markerStart}
#### ${date} ${typeEmoji} ${title}
${itemLines}${filesLine}
${markerEnd}\n\n`;

  if (dryRun) {
    console.log('\n[dry-run] HANDOFF.md 삽입 예정:\n' + block);
    return { file: 'HANDOFF.md', status: 'dry', detail: '삽입 위치: bug-tracker:maintenance:start 위' };
  }

  content = content.replace(insertBefore, block + insertBefore);
  fs.writeFileSync(filePath, content);
  return { file: 'HANDOFF.md', status: 'patched', detail: '유지보수 이력 섹션 위에 삽입' };
}

// ─── DEV_SUMMARY.md 패치 ─────────────────────────────────────────────────
function patchDevSummary(filePath, note, dryRun) {
  const { title, type, items, date, slug } = note;
  const markerComment = `<!-- session-close:${date}:${slug} -->`;

  if (!fs.existsSync(filePath)) {
    return { file: 'DEV_SUMMARY.md', status: 'error', detail: '파일 없음' };
  }

  let content = fs.readFileSync(filePath, 'utf-8');

  if (content.includes(markerComment)) {
    return { file: 'DEV_SUMMARY.md', status: 'skipped', detail: '이미 패치됨' };
  }

  // 타임라인 테이블의 마지막 행 찾기 (| 20XX- 또는 | 202 패턴으로 시작하는 행)
  const lines = content.split('\n');
  let lastTableRowIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\| 20\d\d-/.test(lines[i])) {
      lastTableRowIdx = i;
    }
  }

  if (lastTableRowIdx === -1) {
    return { file: 'DEV_SUMMARY.md', status: 'error', detail: '타임라인 테이블 행 없음 (| 20XX- 패턴)' };
  }

  // 결과 요약: items 첫 번째 + 나머지 수
  const resultSummary = items.length > 1
    ? `${items[0]} 외 ${items.length - 1}건`
    : items[0] || title;

  const newRow = `| ${date} | **${title}** | ${resultSummary} |`;
  const markerRow = markerComment;

  if (dryRun) {
    console.log('\n[dry-run] DEV_SUMMARY.md 삽입 예정 (타임라인 마지막 행 뒤):');
    console.log(newRow);
    return { file: 'DEV_SUMMARY.md', status: 'dry', detail: `타임라인 행 ${lastTableRowIdx + 1} 뒤 삽입` };
  }

  lines.splice(lastTableRowIdx + 1, 0, newRow, markerRow);
  fs.writeFileSync(filePath, lines.join('\n'));
  return { file: 'DEV_SUMMARY.md', status: 'patched', detail: `타임라인 행 ${lastTableRowIdx + 1} 뒤 삽입` };
}

// ─── MEMORY.md 패치 ──────────────────────────────────────────────────────
function patchMemory(filePath, note, dryRun) {
  const { title, type, items, date, slug } = note;
  const markerComment = `<!-- session-close:${date}:${slug} -->`;

  if (!fs.existsSync(filePath)) {
    return { file: 'MEMORY.md', status: 'error', detail: '파일 없음' };
  }

  let content = fs.readFileSync(filePath, 'utf-8');

  if (content.includes(markerComment)) {
    return { file: 'MEMORY.md', status: 'skipped', detail: '이미 패치됨' };
  }

  // 삽입 위치: - **다음 작업**: 줄 바로 위
  const insertBefore = '- **다음 작업**:';
  if (!content.includes(insertBefore)) {
    return { file: 'MEMORY.md', status: 'error', detail: `삽입 마커 없음: ${insertBefore}` };
  }

  // items 요약: 파이프로 연결
  const itemsSummary = items.join(' | ');

  const newLine = `  - **완료 (${date})**: ${title} — ${itemsSummary}\n${markerComment}\n`;

  if (dryRun) {
    console.log('\n[dry-run] MEMORY.md 삽입 예정 (다음 작업 줄 위):');
    console.log(newLine);
    return { file: 'MEMORY.md', status: 'dry', detail: '다음 작업 줄 위에 삽입' };
  }

  content = content.replace(insertBefore, newLine + insertBefore);
  fs.writeFileSync(filePath, content);
  return { file: 'MEMORY.md', status: 'patched', detail: '다음 작업 줄 위에 삽입' };
}

// ─── work-history.md 패치 ────────────────────────────────────────────────
function patchWorkHistory(filePath, note, dryRun) {
  const { title, type, items, date, slug } = note;
  const marker = `<!-- session-close:${date}:${slug} -->`;

  if (!fs.existsSync(filePath)) {
    return { file: 'work-history.md', status: 'error', detail: '파일 없음' };
  }

  let content = fs.readFileSync(filePath, 'utf-8');

  if (content.includes(marker)) {
    return { file: 'work-history.md', status: 'skipped', detail: '이미 패치됨' };
  }

  const typeEmoji = { feature: '✨', fix: '🔧', refactor: '♻️', ops: '⚙️', config: '⚙️' }[type] || '📝';
  const itemLines = items.map(i => `- ${i}`).join('\n');
  const newBlock = `\n### ${typeEmoji} ${title}\n${itemLines}\n${marker}\n`;
  const dateHeader = `## ${date}`;

  if (content.includes(dateHeader)) {
    // 기존 날짜 섹션에 추가 — 다음 날짜 섹션 바로 앞
    const nextSection = content.indexOf('\n## ', content.indexOf(dateHeader) + 1);
    if (nextSection === -1) {
      content = content.trimEnd() + newBlock;
    } else {
      content = content.slice(0, nextSection) + newBlock + content.slice(nextSection);
    }
  } else {
    // 새 날짜 섹션 생성 — 첫 번째 ## 앞에 삽입 (최신이 위)
    const firstSection = content.indexOf('\n## ');
    const newSection = `\n${dateHeader}${newBlock}`;
    if (firstSection === -1) {
      content = content.trimEnd() + '\n' + newSection;
    } else {
      content = content.slice(0, firstSection) + '\n' + newSection + content.slice(firstSection);
    }
  }

  if (dryRun) {
    console.log('\n[dry-run] work-history.md 삽입 예정:\n' + newBlock);
    return { file: 'work-history.md', status: 'dry', detail: `${dateHeader} 섹션에 추가` };
  }

  fs.writeFileSync(filePath, content);
  return { file: 'work-history.md', status: 'patched', detail: `${dateHeader} 섹션에 추가` };
}

// ─── coding-guide.md 변경 이력 패치 ─────────────────────────────────────
function patchCodingGuide(filePath, note, dryRun) {
  const { title, type, items, date, slug } = note;
  const marker = `<!-- session-close:${date}:${slug} -->`;

  if (!fs.existsSync(filePath)) {
    return { file: 'coding-guide.md', status: 'error', detail: '파일 없음' };
  }

  let content = fs.readFileSync(filePath, 'utf-8');

  if (content.includes(marker)) {
    return { file: 'coding-guide.md', status: 'skipped', detail: '이미 패치됨' };
  }

  // "마지막 업데이트" 날짜 갱신
  content = content.replace(
    /> 마지막 업데이트: \d{4}-\d{2}-\d{2}/,
    `> 마지막 업데이트: ${date}`
  );

  // 변경 이력 테이블에 행 추가
  const tableMarker = '| 날짜 | 내용 |';
  if (!content.includes(tableMarker)) {
    return { file: 'coding-guide.md', status: 'error', detail: '변경 이력 테이블 없음' };
  }

  const summary = items.length > 1 ? `${items[0]} 외 ${items.length - 1}건` : items[0] || title;
  const newRow = `| ${date} | **${title}** — ${summary} |\n${marker}`;

  // 테이블 마지막 행 뒤에 추가
  const lines = content.split('\n');
  let lastTableRowIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\| 20\d\d-/.test(lines[i])) lastTableRowIdx = i;
  }

  if (lastTableRowIdx === -1) {
    // 테이블 헤더 바로 뒤 (구분선 다음)
    const headerIdx = lines.findIndex(l => l.includes(tableMarker));
    lines.splice(headerIdx + 2, 0, newRow);
  } else {
    lines.splice(lastTableRowIdx + 1, 0, newRow);
  }

  content = lines.join('\n');

  if (dryRun) {
    console.log('\n[dry-run] coding-guide.md 변경 이력 추가:\n' + newRow);
    return { file: 'coding-guide.md', status: 'dry', detail: '변경 이력 테이블에 행 추가' };
  }

  fs.writeFileSync(filePath, content);
  return { file: 'coding-guide.md', status: 'patched', detail: '변경 이력 테이블 + 날짜 갱신' };
}

module.exports = { patchDocs };
