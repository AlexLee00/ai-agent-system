'use strict';

/**
 * lib/bug-report.js — 덱스터 버그 레포트 등록
 *
 * 코드 수정 없이 자동 처리 불가한 이슈를 버그 트래커에 등록.
 * 스카팀 버그 트래커 (~/.openclaw/workspace/bug-tracker.json)와
 * 별도 투자봇 이슈 파일을 모두 사용.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const TRACKER_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'bug-tracker.json');
const DEXTER_LOG   = path.join(os.homedir(), 'projects', 'ai-agent-system', 'bots', 'claude', 'dexter-issues.json');

function loadTracker(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return { bugs: [] }; }
}

function saveTracker(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function generateId(prefix = 'DXT') {
  return `${prefix}-${String(Date.now()).slice(-6)}`;
}

/**
 * @param {{ title: string, detail: string, source: string, severity: 'high'|'medium'|'low' }} opts
 * @returns {string} 생성된 버그 ID
 */
async function register({ title, detail, source = 'dexter', severity = 'medium' }) {
  const id        = generateId();
  const timestamp = new Date().toISOString();

  const entry = {
    id,
    title,
    detail,
    source,
    severity,
    status:    'open',
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  // 덱스터 자체 이슈 로그에 기록
  const dexterLog = loadTracker(DEXTER_LOG);
  if (!dexterLog.bugs) dexterLog.bugs = [];

  // 중복 체크 (같은 제목의 open 버그가 있으면 스킵)
  const dup = dexterLog.bugs.find(b => b.title === title && b.status === 'open');
  if (dup) return dup.id;

  dexterLog.bugs.push(entry);
  saveTracker(DEXTER_LOG, dexterLog);

  // 스카팀 버그 트래커에도 등록 (파일 존재 시)
  if (fs.existsSync(TRACKER_PATH)) {
    const tracker = loadTracker(TRACKER_PATH);
    if (!tracker.bugs) tracker.bugs = [];
    const dupGlobal = tracker.bugs.find(b => b.title === title && b.status !== 'resolved');
    if (!dupGlobal) {
      tracker.bugs.push({ ...entry, tags: ['dexter', 'auto-detected'] });
      saveTracker(TRACKER_PATH, tracker);
    }
  }

  return id;
}

/**
 * open 상태 이슈 목록 조회
 */
function listOpen() {
  const data = loadTracker(DEXTER_LOG);
  return (data.bugs || []).filter(b => b.status === 'open');
}

/**
 * 이슈 해결 처리
 */
function resolve(id) {
  const data = loadTracker(DEXTER_LOG);
  const bug  = data.bugs?.find(b => b.id === id);
  if (bug) {
    bug.status    = 'resolved';
    bug.updatedAt = new Date().toISOString();
    saveTracker(DEXTER_LOG, data);
    return true;
  }
  return false;
}

module.exports = { register, listOpen, resolve };
