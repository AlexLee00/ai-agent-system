-- Migration 011: blog.topic_queue — D-1 사전 선정 단일 최우선 주제
-- topic_planner.ts가 매일 21:00 KST에 내일 최적 주제 1건 저장
-- topic-selector.ts가 D-day에 이 테이블을 1순위로 조회

CREATE TABLE IF NOT EXISTS blog.topic_queue (
  id               SERIAL PRIMARY KEY,
  category         VARCHAR(50)  NOT NULL,
  title            TEXT         NOT NULL,
  question         TEXT,
  diff             TEXT,
  reader_problem   TEXT,
  opening_angle    TEXT,
  key_questions    TEXT[],
  closing_angle    TEXT,
  trend_source     TEXT,          -- 'github' | 'hn' | 'mixed' | 'llm_only'
  trend_summary    TEXT,          -- 수집된 이슈 요약
  quality_score    FLOAT        DEFAULT 0,
  duplicate_check  BOOLEAN      DEFAULT FALSE,  -- 30일 중복 검사 통과 여부
  status           VARCHAR(20)  DEFAULT 'pending',  -- pending / consumed / expired
  scheduled_date   DATE         NOT NULL,       -- 사용 예정일 (= 내일)
  created_at       TIMESTAMP    DEFAULT NOW(),
  consumed_at      TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_topic_queue_date_status
  ON blog.topic_queue (scheduled_date, status);
