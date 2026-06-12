-- CODEX-B1: 기존 AI 구현 입문 120강 계획을 '에이전트 입문' 48강 체계로 재편한다.
-- 적용은 마스터가 수행한다. 본 파일은 멱등 재실행을 목표로 한다.

BEGIN;

CREATE SCHEMA IF NOT EXISTS blog;

ALTER TABLE blog.curriculum
  ADD COLUMN IF NOT EXISTS series_id INTEGER;
ALTER TABLE blog.curriculum
  ADD COLUMN IF NOT EXISTS section VARCHAR(50);
ALTER TABLE blog.curriculum
  ADD COLUMN IF NOT EXISTS keywords TEXT[];

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'blog.curriculum'::regclass
      AND conname = 'curriculum_status_check'
  ) THEN
    ALTER TABLE blog.curriculum DROP CONSTRAINT curriculum_status_check;
  END IF;

  ALTER TABLE blog.curriculum
    ADD CONSTRAINT curriculum_status_check
    CHECK (status IN ('pending', 'published', 'skipped', 'archived', 'draft', 'ready', 'failed'))
    NOT VALID;
END $$;

CREATE TEMP TABLE _blo_b1_target_series (id INTEGER) ON COMMIT DROP;

INSERT INTO _blo_b1_target_series (id)
SELECT id
FROM blog.curriculum_series
WHERE series_name IN (
  '에이전트 입문',
  'ChatGPT Codex와 Claude Code로 따라 만드는 실전 AI 구현 입문'
)
ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, id DESC
LIMIT 1;

INSERT INTO blog.curriculum_series (series_name, total_lectures, status, start_date)
SELECT '에이전트 입문', 48, 'active', CURRENT_DATE
WHERE NOT EXISTS (SELECT 1 FROM _blo_b1_target_series);

INSERT INTO _blo_b1_target_series (id)
SELECT id
FROM blog.curriculum_series
WHERE series_name = '에이전트 입문'
  AND NOT EXISTS (SELECT 1 FROM _blo_b1_target_series)
ORDER BY id DESC
LIMIT 1;

UPDATE blog.curriculum_series
SET status = 'completed',
    end_date = COALESCE(end_date, CURRENT_DATE)
WHERE status = 'active'
  AND id <> (SELECT id FROM _blo_b1_target_series LIMIT 1);

UPDATE blog.curriculum_series
SET series_name = '에이전트 입문',
    total_lectures = 48,
    status = 'active',
    start_date = COALESCE(start_date, CURRENT_DATE),
    end_date = NULL
WHERE id = (SELECT id FROM _blo_b1_target_series LIMIT 1);

UPDATE blog.curriculum
SET series_name = '에이전트 입문',
    series_id = (SELECT id FROM _blo_b1_target_series LIMIT 1)
WHERE series_name IN (
  '에이전트 입문',
  'ChatGPT Codex와 Claude Code로 따라 만드는 실전 AI 구현 입문'
);

WITH target AS (
  SELECT id AS series_id FROM _blo_b1_target_series LIMIT 1
),
lessons(lecture_number, section, title, keywords) AS (
  VALUES
    (1, 'S1', 'AI 코딩 에이전트 이해와 첫 실습 준비', ARRAY['AI 코딩 에이전트','첫 실습','준비']::text[]),
    (2, 'S1', 'Codex vs Claude Code 비교', ARRAY['Codex','Claude Code','비교']::text[]),
    (3, 'S1', '실습 폴더와 Git 기본 환경', ARRAY['실습 폴더','Git','환경']::text[]),
    (4, 'S1', '프롬프트 한 줄로 웹페이지 초안', ARRAY['프롬프트','웹페이지','초안']::text[]),
    (5, 'S1', 'Claude Code 설치 따라하기', ARRAY['Claude Code','설치','따라하기']::text[]),
    (6, 'S1', 'Codex 설치 따라하기', ARRAY['Codex','설치','따라하기']::text[]),
    (7, 'S1', '터미널 무서워하지 않기', ARRAY['터미널','명령어','입문']::text[]),
    (8, 'S1', '에이전트와 첫 대화', ARRAY['에이전트','첫 대화','질문']::text[]),
    (9, 'S2', '좋은 프롬프트 vs 나쁜 프롬프트', ARRAY['좋은 프롬프트','나쁜 프롬프트','비교']::text[]),
    (10, 'S2', '구체적으로 말하는 법', ARRAY['구체적 지시','프롬프트','맥락']::text[]),
    (11, 'S2', '큰 일은 단계로 나누기', ARRAY['작업 분해','단계','계획']::text[]),
    (12, 'S2', '예시 들어주기', ARRAY['예시','샘플','프롬프트']::text[]),
    (13, 'S2', 'CLAUDE.md로 내 상황 알려주기', ARRAY['CLAUDE.md','프로젝트 맥락','지시문']::text[]),
    (14, 'S2', '자주 하는 실수 5가지', ARRAY['실수','프롬프트 오류','개선']::text[]),
    (15, 'S2', '"계획부터 보여줘" 기법', ARRAY['계획','검토','작업 전 확인']::text[]),
    (16, 'S2', '결과 다듬는 대화법', ARRAY['결과 개선','피드백','반복']::text[]),
    (17, 'S3', '파일 읽고 고치게 하기', ARRAY['파일 읽기','파일 수정','에이전트 도구']::text[]),
    (18, 'S3', '스크린샷과 이미지 활용', ARRAY['스크린샷','이미지','시각 자료']::text[]),
    (19, 'S3', '웹 검색 시키기', ARRAY['웹 검색','최신 정보','검증']::text[]),
    (20, 'S3', '긴 작업 맡기기', ARRAY['긴 작업','진행 관리','자율 작업']::text[]),
    (21, 'S3', 'git으로 되돌리기(안전망)', ARRAY['git','되돌리기','안전망']::text[]),
    (22, 'S3', '결과 검증 습관', ARRAY['검증','테스트','확인']::text[]),
    (23, 'S3', '비용과 한도 이해', ARRAY['비용','한도','토큰']::text[]),
    (24, 'S3', '권한과 안전 설정', ARRAY['권한','안전 설정','승인']::text[]),
    (25, 'S4', '파일 정리 자동화', ARRAY['파일 정리','자동화','폴더']::text[]),
    (26, 'S4', '엑셀·CSV 정리', ARRAY['엑셀','CSV','데이터 정리']::text[]),
    (27, 'S4', '이메일 초안 비서', ARRAY['이메일','초안','비서']::text[]),
    (28, 'S4', '회의록 요약', ARRAY['회의록','요약','업무 자동화']::text[]),
    (29, 'S4', '사진 일괄 이름변경', ARRAY['사진','일괄 변경','파일명']::text[]),
    (30, 'S4', '간단 웹페이지 만들기', ARRAY['웹페이지','HTML','초보 프로젝트']::text[]),
    (31, 'S4', 'PDF 요약', ARRAY['PDF','요약','문서']::text[]),
    (32, 'S4', '데이터 차트', ARRAY['데이터','차트','시각화']::text[]),
    (33, 'S4', '일정 정리', ARRAY['일정','정리','캘린더']::text[]),
    (34, 'S4', '종합 연습', ARRAY['종합 연습','미니 프로젝트','복습']::text[]),
    (35, 'S5', '에이전트 = 지시문+도구', ARRAY['에이전트','지시문','도구']::text[]),
    (36, 'S5', 'CLAUDE.md로 나만의 비서', ARRAY['CLAUDE.md','개인 비서','커스텀']::text[]),
    (37, 'S5', '커스텀 명령어', ARRAY['커스텀 명령어','명령','반복 작업']::text[]),
    (38, 'S5', '스케줄 자동 실행 맛보기', ARRAY['스케줄','자동 실행','반복 작업']::text[]),
    (39, 'S5', 'MCP로 도구 연결 맛보기', ARRAY['MCP','도구 연결','확장']::text[]),
    (40, 'S5', '에이전트에게 자기검증 시키기', ARRAY['자기검증','검증 루프','품질 확인']::text[]),
    (41, 'S5', '작은 자동화 비서 완성 (상)', ARRAY['자동화 비서','프로젝트','상편']::text[]),
    (42, 'S5', '작은 자동화 비서 완성 (하)', ARRAY['자동화 비서','프로젝트','하편']::text[]),
    (43, 'S6', '에이전트 협업 습관', ARRAY['협업 습관','에이전트 활용','업무 방식']::text[]),
    (44, 'S6', '공식문서·커뮤니티 활용법', ARRAY['공식문서','커뮤니티','학습']::text[]),
    (45, 'S6', '트러블슈팅', ARRAY['트러블슈팅','오류 해결','디버깅']::text[]),
    (46, 'S6', '종합 프로젝트 (상)', ARRAY['종합 프로젝트','상편','실습']::text[]),
    (47, 'S6', '종합 프로젝트 (하)', ARRAY['종합 프로젝트','하편','완성']::text[]),
    (48, 'S6', '수료와 다음 과정 예고', ARRAY['수료','다음 과정','로드맵']::text[])
)
INSERT INTO blog.curriculum
  (series_id, series_name, lecture_number, title, section, keywords, difficulty, status)
SELECT
  target.series_id,
  '에이전트 입문',
  lessons.lecture_number,
  lessons.title,
  lessons.section,
  lessons.keywords,
  '입문',
  'pending'
FROM target
CROSS JOIN lessons
ON CONFLICT (series_name, lecture_number) DO UPDATE
SET series_id = EXCLUDED.series_id,
    title = CASE
      WHEN blog.curriculum.lecture_number <= 4 THEN blog.curriculum.title
      ELSE EXCLUDED.title
    END,
    section = EXCLUDED.section,
    keywords = EXCLUDED.keywords,
    difficulty = '입문',
    status = CASE
      WHEN blog.curriculum.lecture_number <= 4 THEN blog.curriculum.status
      ELSE 'pending'
    END;

UPDATE blog.curriculum
SET status = 'archived',
    series_id = (SELECT id FROM _blo_b1_target_series LIMIT 1)
WHERE series_name = '에이전트 입문'
  AND lecture_number BETWEEN 49 AND 120;

UPDATE blog.category_rotation
SET current_index = 4,
    series_name = '에이전트 입문',
    updated_at = NOW()
WHERE rotation_type = 'lecture_series';

INSERT INTO blog.category_rotation (rotation_type, current_index, series_name)
SELECT 'lecture_series', 4, '에이전트 입문'
WHERE NOT EXISTS (
  SELECT 1 FROM blog.category_rotation WHERE rotation_type = 'lecture_series'
);

COMMIT;
