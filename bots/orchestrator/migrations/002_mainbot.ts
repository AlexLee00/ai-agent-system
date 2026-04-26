// @ts-nocheck
'use strict';

/**
 * migrations/002_mainbot.js — 메인봇 DB 마이그레이션
 *
 * claude-team.db 확장:
 *   - mainbot_queue     봇→메인봇 메시지 큐
 *   - mute_settings     알람 무음 설정
 *   - command_history   명령 히스토리 + LLM 파싱 추적
 *   - pending_confirms  Lv3/Lv4 확인 대기
 *   - morning_queue     야간 보류 알람 (08:00 브리핑)
 *   - token_usage       봇별 LLM 토큰 사용 기록 (무료/유료 통합)
 */

const path     = require('path');
const os       = require('os');
const fs       = require('fs');
const Database = require('better-sqlite3');

function getAiAgentWorkspace() {
  const home = process.env.AI_AGENT_HOME || process.env.JAY_HOME || path.join(os.homedir(), '.ai-agent-system');
  return process.env.AI_AGENT_WORKSPACE || process.env.JAY_WORKSPACE || path.join(home, 'workspace');
}

const DB_PATH = path.join(getAiAgentWorkspace(), 'claude-team.db');

function run() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- 마이그레이션 테이블 (없으면 생성)
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const already = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(2);
  if (already) {
    console.log('✅ 002_mainbot 이미 적용됨 — 스킵');
    db.close();
    return;
  }

  console.log('🔧 002_mainbot 마이그레이션 시작...');

  db.exec(`
    -- ─── 1. 메시지 큐 ────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS mainbot_queue (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      from_bot     TEXT    NOT NULL,           -- 발신 봇 ID (dexter, luna, ska...)
      team         TEXT    NOT NULL,           -- 팀 (claude|investment|reservation)
      event_type   TEXT    NOT NULL,           -- 이벤트 유형 (trade|alert|system|report)
      alert_level  INTEGER NOT NULL DEFAULT 2, -- 1=LOW 2=MEDIUM 3=HIGH 4=CRITICAL
      message      TEXT    NOT NULL,           -- 사람이 읽는 메시지
      payload      TEXT,                       -- JSON 구조화 데이터 (nullable)
      status       TEXT    NOT NULL DEFAULT 'pending',  -- pending|sent|muted|batched
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mq_status     ON mainbot_queue(status);
    CREATE INDEX IF NOT EXISTS idx_mq_alert      ON mainbot_queue(alert_level);
    CREATE INDEX IF NOT EXISTS idx_mq_created    ON mainbot_queue(created_at);
    CREATE INDEX IF NOT EXISTS idx_mq_from_bot   ON mainbot_queue(from_bot);

    -- ─── 2. 무음 설정 ───────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS mute_settings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      target      TEXT    NOT NULL,  -- 'all' | 팀명 | 봇명
      mute_until  TEXT    NOT NULL,  -- ISO8601
      reason      TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      created_by  TEXT    NOT NULL DEFAULT 'user'
    );
    CREATE INDEX IF NOT EXISTS idx_mute_target ON mute_settings(target);
    CREATE INDEX IF NOT EXISTS idx_mute_until  ON mute_settings(mute_until);

    -- ─── 3. 명령 히스토리 ───────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS command_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_text      TEXT    NOT NULL,           -- 원본 텍스트
      intent        TEXT,                       -- 파싱된 인텐트 (status|mute|luna|ska|cost|help)
      parse_source  TEXT,                       -- slash|keyword|groq|failed
      llm_tokens_in  INTEGER DEFAULT 0,         -- LLM 파싱 사용 입력 토큰
      llm_tokens_out INTEGER DEFAULT 0,         -- LLM 파싱 사용 출력 토큰
      llm_cost_usd  REAL    DEFAULT 0,          -- 비용 (무료=0)
      response_ms   INTEGER,                    -- 응답 생성 소요 ms
      success       INTEGER DEFAULT 1,          -- 1=성공 0=실패
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cmd_created ON command_history(created_at);
    CREATE INDEX IF NOT EXISTS idx_cmd_source  ON command_history(parse_source);

    -- ─── 4. 확인 대기 ───────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS pending_confirms (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_id     INTEGER REFERENCES mainbot_queue(id),
      confirm_key  TEXT    NOT NULL UNIQUE,     -- 승인/거부 키
      message      TEXT    NOT NULL,
      expires_at   TEXT    NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'pending',  -- pending|approved|rejected|expired
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      resolved_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pc_key    ON pending_confirms(confirm_key);
    CREATE INDEX IF NOT EXISTS idx_pc_status ON pending_confirms(status);

    -- ─── 5. 야간 보류 큐 ────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS morning_queue (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_id    INTEGER REFERENCES mainbot_queue(id),
      summary     TEXT    NOT NULL,   -- 배치 요약 메시지
      bot_list    TEXT    NOT NULL,   -- JSON 배열 ["luna","ska"]
      event_count INTEGER DEFAULT 1,
      deferred_at TEXT    NOT NULL DEFAULT (datetime('now')),
      sent_at     TEXT
    );

    -- ─── 6. 토큰 사용 기록 (봇별, 무료/유료 통합) ──────────────────
    CREATE TABLE IF NOT EXISTS token_usage (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_name      TEXT    NOT NULL,           -- 봇명 (archer, luna, jason, 메인봇...)
      team          TEXT    NOT NULL,           -- 팀 (claude|investment|orchestrator)
      model         TEXT    NOT NULL,           -- 모델명
      provider      TEXT    NOT NULL,           -- anthropic|groq
      is_free       INTEGER NOT NULL DEFAULT 0, -- 1=무료(Groq), 0=유료
      task_type     TEXT,                       -- 업무 유형 (tech_analysis|trade_signal|command_parse|report...)
      tokens_in     INTEGER NOT NULL DEFAULT 0,
      tokens_out    INTEGER NOT NULL DEFAULT 0,
      cost_usd      REAL    NOT NULL DEFAULT 0,
      recorded_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      date_kst      TEXT    NOT NULL DEFAULT (date('now'))  -- 집계용 날짜
    );
    CREATE INDEX IF NOT EXISTS idx_tu_bot      ON token_usage(bot_name);
    CREATE INDEX IF NOT EXISTS idx_tu_date     ON token_usage(date_kst);
    CREATE INDEX IF NOT EXISTS idx_tu_team     ON token_usage(team);
    CREATE INDEX IF NOT EXISTS idx_tu_model    ON token_usage(model);
  `);

  db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(2, '002_mainbot');

  console.log('✅ 002_mainbot 마이그레이션 완료');
  console.log('   추가된 테이블: mainbot_queue, mute_settings, command_history, pending_confirms, morning_queue, token_usage');

  // 체크포인트 (WAL 파일 정리)
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  db.close();
}

run();
