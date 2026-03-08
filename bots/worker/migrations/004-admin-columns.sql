-- 004-admin-columns.sql — worker.users 관리 컬럼 추가
-- channel: 'web' (아이디/비밀번호) | 'telegram' (텔레그램 인증)
-- must_change_pw: 첫 로그인 시 비밀번호 강제 변경 플래그
-- last_login_at: 마지막 로그인 시각

ALTER TABLE worker.users
  ADD COLUMN IF NOT EXISTS channel        VARCHAR(20) NOT NULL DEFAULT 'web',
  ADD COLUMN IF NOT EXISTS must_change_pw BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_login_at  TIMESTAMPTZ;
