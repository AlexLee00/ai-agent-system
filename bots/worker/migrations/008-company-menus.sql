-- 워커팀 Phase 4.5 — 업체별 메뉴 설정
-- companies 테이블에 enabled_menus 컬럼 추가

ALTER TABLE worker.companies
  ADD COLUMN IF NOT EXISTS enabled_menus JSONB DEFAULT NULL;

-- NULL = 전체 메뉴 활성화 (기존 업체 호환)
-- 예: ["dashboard","employees","attendance","sales","settings"]
COMMENT ON COLUMN worker.companies.enabled_menus IS
  '업체별 활성화된 메뉴 키 배열. NULL이면 전체 메뉴 활성화.';
