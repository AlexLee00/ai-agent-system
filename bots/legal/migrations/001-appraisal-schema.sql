-- 감정팀 DB 스키마 마이그레이션
-- 실행: psql -U jay -d jay -f 001-appraisal-schema.sql
-- OPS에서 마스터가 직접 실행

CREATE SCHEMA IF NOT EXISTS legal;

-- 감정 사건
CREATE TABLE IF NOT EXISTS legal.cases (
  id SERIAL PRIMARY KEY,
  case_number TEXT NOT NULL UNIQUE,     -- 법원 사건번호 (예: 서울중앙지방법원 2026가합12345)
  court TEXT,                           -- 관할 법원
  case_type TEXT CHECK (case_type IN ('copyright', 'defect', 'contract', 'trade_secret', 'other')),
  plaintiff TEXT,                       -- 원고
  defendant TEXT,                       -- 피고
  appraisal_items JSONB DEFAULT '[]',   -- 감정사항 목록
  status TEXT DEFAULT 'received' CHECK (status IN (
    'received', 'analyzing', 'planning', 'questioning1', 'interview1',
    'questioning2', 'interview2', 'inspection_plan', 'inspecting',
    'drafting', 'reviewing', 'completed', 'submitted'
  )),
  assigned_agents JSONB DEFAULT '[]',   -- 배정된 에이전트 목록
  deadline DATE,                        -- 감정서 제출 기한
  notes TEXT,                           -- 메모
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- 코드 분석 결과
CREATE TABLE IF NOT EXISTS legal.code_analyses (
  id SERIAL PRIMARY KEY,
  case_id INTEGER REFERENCES legal.cases(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,                  -- 분석 에이전트 (lens/claim/defense)
  analysis_type TEXT CHECK (analysis_type IN (
    'similarity', 'structure', 'function_mapping', 'copy_detection', 'plaintiff_analysis', 'defendant_analysis'
  )),
  source_type TEXT CHECK (source_type IN ('web', 'app', 'db', 'embedded', 'desktop', 'other')),
  similarity_score NUMERIC(5,2),        -- 유사도 % (0~100)
  mapping_data JSONB DEFAULT '{}',      -- 기능 매핑 테이블
  evidence JSONB DEFAULT '[]',          -- 증거 (파일명, 라인번호, 경로)
  conclusion TEXT,                      -- 분석 결론
  raw_output TEXT,                      -- LLM 원본 출력
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 판례 검색 결과
CREATE TABLE IF NOT EXISTS legal.case_references (
  id SERIAL PRIMARY KEY,
  case_id INTEGER REFERENCES legal.cases(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,                  -- 검색 에이전트 (garam/atlas)
  ref_case_number TEXT,                 -- 참조 판례 사건번호
  court TEXT,                           -- 판결 법원
  decision_date DATE,                   -- 판결일
  summary TEXT,                         -- 판결 요지
  applicable_law TEXT,                  -- 적용 법률/조항
  relevance_score NUMERIC(3,1) DEFAULT 0, -- 관련성 점수 (0~10)
  jurisdiction TEXT DEFAULT 'domestic' CHECK (jurisdiction IN ('domestic', 'foreign')),
  raw_output TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 감정서 버전 관리
CREATE TABLE IF NOT EXISTS legal.reports (
  id SERIAL PRIMARY KEY,
  case_id INTEGER REFERENCES legal.cases(id) ON DELETE CASCADE,
  version INTEGER DEFAULT 1,
  report_type TEXT DEFAULT 'final' CHECK (report_type IN (
    'inception_plan', 'query1', 'query2', 'inspection_plan', 'final'
  )),
  content_path TEXT,                    -- 감정서 파일 경로
  content_md TEXT,                      -- 마크다운 본문 (DB 저장)
  review_status TEXT DEFAULT 'draft' CHECK (review_status IN ('draft', 'balance_reviewed', 'justin_reviewed', 'master_approved', 'submitted')),
  review_notes TEXT,                    -- 밸런스/저스틴 피드백
  balance_score JSONB DEFAULT '{}',     -- 밸런스 품질 점수
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 질의/인터뷰 기록
CREATE TABLE IF NOT EXISTS legal.interviews (
  id SERIAL PRIMARY KEY,
  case_id INTEGER REFERENCES legal.cases(id) ON DELETE CASCADE,
  interview_type TEXT DEFAULT 'query1' CHECK (interview_type IN ('query1', 'query2', 'inspection')),
  interviewer TEXT,                     -- 인터뷰 대상 (plaintiff/defendant/both)
  content TEXT,                         -- 질의 내용 / 인터뷰 기록
  response TEXT,                        -- 당사자 답변
  analysis TEXT,                        -- 브리핑의 분석 결과
  conducted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- SW 기능 분류표 (현장실사)
CREATE TABLE IF NOT EXISTS legal.sw_functions (
  id SERIAL PRIMARY KEY,
  case_id INTEGER REFERENCES legal.cases(id) ON DELETE CASCADE,
  category1 TEXT NOT NULL,              -- 1스텝: 대분류
  category2 TEXT,                       -- 2스텝: 중분류
  category3 TEXT,                       -- 3스텝: 소분류
  status TEXT DEFAULT 'unknown' CHECK (status IN ('operational', 'partial', 'inoperative', 'unknown')),
  notes TEXT,                           -- 판정 근거
  inspected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 피드백 (감정 정확도 기록)
CREATE TABLE IF NOT EXISTS legal.feedback (
  id SERIAL PRIMARY KEY,
  case_id INTEGER REFERENCES legal.cases(id) ON DELETE CASCADE,
  court_decision TEXT,                  -- 법원 판결 요지
  appraisal_accuracy TEXT,              -- 감정 정확도 (accurate/partial/inaccurate)
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 업데이트 트리거
CREATE OR REPLACE FUNCTION legal.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'cases_updated_at') THEN
    CREATE TRIGGER cases_updated_at
      BEFORE UPDATE ON legal.cases
      FOR EACH ROW EXECUTE FUNCTION legal.update_updated_at();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'reports_updated_at') THEN
    CREATE TRIGGER reports_updated_at
      BEFORE UPDATE ON legal.reports
      FOR EACH ROW EXECUTE FUNCTION legal.update_updated_at();
  END IF;
END $$;

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_cases_case_number ON legal.cases(case_number);
CREATE INDEX IF NOT EXISTS idx_cases_status ON legal.cases(status);
CREATE INDEX IF NOT EXISTS idx_code_analyses_case_id ON legal.code_analyses(case_id);
CREATE INDEX IF NOT EXISTS idx_case_references_case_id ON legal.case_references(case_id);
CREATE INDEX IF NOT EXISTS idx_reports_case_id ON legal.reports(case_id);
CREATE INDEX IF NOT EXISTS idx_sw_functions_case_id ON legal.sw_functions(case_id);
