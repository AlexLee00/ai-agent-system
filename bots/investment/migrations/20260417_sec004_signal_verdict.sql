-- SEC-004: 네메시스 재검증 가드 지원 컬럼 추가
-- investment.signals 테이블에 nemesis_verdict, approved_at 추가

ALTER TABLE investment.signals
  ADD COLUMN IF NOT EXISTS nemesis_verdict TEXT,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

COMMENT ON COLUMN investment.signals.nemesis_verdict IS 'nemesis 승인 결과: approved | modified | rejected | null(미경유)';
COMMENT ON COLUMN investment.signals.approved_at IS 'nemesis 승인 시각 (SEC-004 stale signal 감지용)';
