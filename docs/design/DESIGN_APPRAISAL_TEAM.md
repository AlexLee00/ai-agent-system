# 감정팀 (Appraisal Team) 설계서

> 작성: 메티 (Claude Opus 4.6) + 마스터 (Jay)
> 작성일: 2026-04-02
> 상태: 설계 단계
> v2 역할: 법원 SW 감정 자동화 — 감정 유형별 전문 에이전트 풀

---

## 1. 팀 개요

```
현재: bots/legal (package.json만 존재, "판례봇" 설명)
변경: bots/legal → 역할 확장 (리네임 없이 역할 재정의)
     "판례봇" → "감정팀 — 법원 SW 감정 자동화 + 판례 분석"

SW 감정이란:
  법원에서 소프트웨어 관련 분쟁(저작권 침해, 하자, 계약 위반 등) 발생 시
  전문가가 소스코드를 분석하여 감정서를 작성하는 업무.
  마스터(Jay)가 법원 SW 감정인으로 활동 중.

핵심 역할:
  ① 감정 유형 분류: 사건 내용 분석 → 감정 유형 자동 분류
  ② 소스코드 분석: 코드 유사도, 구조 분석, 기능 매핑
  ③ 판례 서칭: 유사 판례 검색 → 참고 자료 정리
  ④ 감정서 초안 작성: 분석 결과 → 법원 제출용 감정서 초안
  ⑤ 품질 검증: 감정서 논리 일관성, 법률 용어 정확성 검증
  ⑥ 피드백 학습: 감정 결과 → RAG 저장 → 다음 감정에 참고
```

---

## 2. 팀 구성 (에이전트)

```
팀장: 저지 (Judge) — 감정 총괄, 사건 배정, 최종 검토
  역할: 감정 요청 수신 → 유형 분류 → 에이전트 배정 → 최종 감정서 검토
  모델: anthropic (고품질 판단, 법률 정확성 요구)

에이전트 1: 코드아이 (CodeEye) — 소스코드 분석 전문
  역할: 소스코드 유사도 분석, 구조 분석, 기능 매핑, 복사 여부 판단
  모델: claude-code/sonnet (코드 분석에 최적)
  분석 유형:
    → 코드 유사도: 문자열/토큰/AST 기반 유사도 측정
    → 구조 분석: 아키텍처 패턴, 모듈 의존성, 클래스 계층
    → 기능 매핑: 원고 코드 기능 ↔ 피고 코드 기능 1:1 대응
    → 복사 탐지: 변수명 변경, 주석 제거, 순서 변경 등 난독화 감지
  감정 유형별 특화:
    웹: HTML/CSS/JS 프론트엔드 + 백엔드 API + DB 스키마
    앱: iOS/Android 네이티브 + 크로스플랫폼 (Flutter/RN)
    DB: 스키마 설계, 쿼리 패턴, 저장 프로시저
    임베디드: 펌웨어, 디바이스 드라이버, RTOS
  출력: 코드 분석 리포트 (유사도 %, 매핑 테이블, 증거 스크린샷)

에이전트 2: 케이스헌터 (CaseHunter) — 판례 서칭 전문
  역할: 유사 판례 검색 + 법률 근거 정리 + 선례 분석
  모델: anthropic (법률 문서 분석)
  소스:
    → 대법원 종합법률정보
    → 하급심 판례 DB
    → SW 감정 관련 학술 논문
    → 한국소프트웨어감정평가학회 자료
  출력: 판례 리포트 (유사 사건, 판결 요지, 적용 가능 법리)
  연동: 연구팀 Scout-Legal이 발굴한 자료 활용

에이전트 3: 드래프터 (Drafter) — 감정서 초안 작성 전문
  역할: 분석 결과를 법원 제출용 감정서 형식으로 작성
  모델: anthropic (법률 문서 작성, 정확한 용어)
  입력: 코드아이 분석 리포트 + 케이스헌터 판례 리포트
  출력: 감정서 초안 (법원 양식 준수)
  감정서 구조:
    1) 감정 개요 (사건번호, 당사자, 감정사항)
    2) 분석 방법론 (사용 도구, 분석 기준)
    3) 분석 결과 (유사도, 매핑, 증거)
    4) 판례 참조 (유사 사건 선례)
    5) 감정 의견 (결론 + 근거)
    6) 첨부 자료 (코드 비교표, 스크린샷)

에이전트 4: 리뷰어 (Reviewer) — 감정서 품질 검증
  역할: 감정서 초안의 논리 일관성, 법률 용어 정확성, 증거 충분성 검증
  모델: anthropic (비판적 분석)
  검증 항목:
    → 논리 일관성: 분석 결과와 결론이 일치하는가
    → 법률 정확성: 법률 용어, 조항 인용이 정확한가
    → 증거 충분성: 결론을 뒷받침하는 증거가 충분한가
    → 중립성: 한쪽에 치우치지 않는 객관적 서술인가
    → 형식 준수: 법원 감정서 양식에 맞는가
  출력: 리뷰 리포트 (수정 필요 항목, 보완 제안)
  원칙: 드래프터와 독립적 판단 (작성자 ≠ 검증자)
```

---

## 3. 디렉토리 구조

```
bots/legal/                          ← 기존 디렉토리 활용
├── package.json                     ← 업데이트
├── CLAUDE.md                        ← Claude Code 컨텍스트
├── config.json                      ← 런타임 설정
├── context/
│   ├── JUDGE_PERSONA.md             ← 팀장 페르소나
│   ├── APPRAISAL_GUIDELINES.md      ← 감정 가이드라인 (법원 양식, 작성 원칙)
│   └── LEGAL_TERMS.md               ← 법률 용어 사전
├── lib/
│   ├── judge.js                     ← 팀장 (사건 배정, 최종 검토)
│   ├── code-eye.js                  ← 소스코드 분석
│   ├── case-hunter.js               ← 판례 서칭
│   ├── drafter.js                   ← 감정서 초안 작성
│   ├── reviewer.js                  ← 품질 검증
│   ├── appraisal-store.js           ← 감정 DB 저장
│   └── similarity-engine.js         ← 코드 유사도 측정 엔진
├── scripts/
│   ├── start-appraisal.js           ← 감정 시작 CLI
│   ├── generate-report.js           ← 감정서 PDF 생성
│   └── health-check.js              ← 헬스 체크
├── templates/
│   ├── appraisal-report.md          ← 감정서 템플릿
│   └── code-comparison-table.md     ← 코드 비교표 템플릿
├── cases/                           ← 사건별 작업 디렉토리
│   ├── 2026-CASE-001/
│   │   ├── source-plaintiff/        ← 원고 소스코드
│   │   ├── source-defendant/        ← 피고 소스코드
│   │   ├── analysis/                ← 분석 결과
│   │   └── report/                  ← 감정서
│   └── ...
├── launchd/                         ← (필요 시, 감정은 수동 시작이 기본)
└── migrations/
    └── 001-appraisal-schema.sql     ← DB 스키마
```

---

## 4. DB 스키마 (PostgreSQL, legal 스키마)

```sql
-- 감정 사건
CREATE TABLE legal.cases (
  id SERIAL PRIMARY KEY,
  case_number TEXT NOT NULL,          -- 법원 사건번호
  court TEXT,                         -- 관할 법원
  case_type TEXT,                     -- copyright/defect/contract/trade_secret
  plaintiff TEXT,                     -- 원고
  defendant TEXT,                     -- 피고
  appraisal_items JSONB,             -- 감정사항 목록
  status TEXT DEFAULT 'received',     -- received/analyzing/drafting/reviewing/completed
  assigned_agents JSONB,              -- 배정된 에이전트 목록
  deadline DATE,                      -- 감정서 제출 기한
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- 코드 분석 결과
CREATE TABLE legal.code_analyses (
  id SERIAL PRIMARY KEY,
  case_id INTEGER REFERENCES legal.cases(id),
  analysis_type TEXT,                 -- similarity/structure/function_mapping/copy_detection
  source_type TEXT,                   -- web/app/db/embedded
  similarity_score NUMERIC(5,2),     -- 유사도 % (0~100)
  mapping_data JSONB,                -- 기능 매핑 테이블
  evidence JSONB,                    -- 증거 (파일명, 라인번호, 스크린샷 경로)
  conclusion TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 판례 검색 결과
CREATE TABLE legal.case_references (
  id SERIAL PRIMARY KEY,
  case_id INTEGER REFERENCES legal.cases(id),
  ref_case_number TEXT,              -- 참조 판례 사건번호
  court TEXT,                        -- 판결 법원
  decision_date DATE,                -- 판결일
  summary TEXT,                      -- 판결 요지
  applicable_law TEXT,               -- 적용 법률/조항
  relevance_score NUMERIC(3,1),      -- 관련성 점수
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 감정서 버전 관리
CREATE TABLE legal.reports (
  id SERIAL PRIMARY KEY,
  case_id INTEGER REFERENCES legal.cases(id),
  version INTEGER DEFAULT 1,
  content_path TEXT,                  -- 감정서 파일 경로
  review_status TEXT DEFAULT 'draft', -- draft/reviewed/approved/submitted
  review_notes TEXT,                  -- 리뷰어 피드백
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 5. 핵심 워크플로우

### 5-1. 감정 프로세스 (사건 수임~감정서 제출)

```
마스터가 감정 요청 수신 (법원 공문)
  ↓
[Phase 1: 사건 등록] 저지(팀장)
  → 사건번호, 당사자, 감정사항 등록 (legal.cases INSERT)
  → 감정 유형 분류 (저작권/하자/계약/영업비밀)
  → 소스코드 수령 → cases/2026-CASE-XXX/ 디렉토리 생성
  → 에이전트 배정 (유형에 따라 코드아이 전문분야 선택)
  ↓
[Phase 2: 코드 분석] 코드아이
  → 원고/피고 소스코드 로드
  → 유사도 측정 (문자열/토큰/AST 3중 분석)
  → 기능 매핑 테이블 작성
  → 복사 탐지 (변수명 변경, 난독화 감지)
  → 분석 결과 → legal.code_analyses INSERT
  ↓
[Phase 3: 판례 서칭] 케이스헌터
  → 유사 사건 판례 검색
  → 적용 가능 법리 정리
  → 결과 → legal.case_references INSERT
  ↓
[Phase 4: 감정서 작성] 드래프터
  → 코드아이 분석 + 케이스헌터 판례 → 감정서 초안 작성
  → 법원 양식 준수 (templates/appraisal-report.md)
  → 초안 → legal.reports INSERT (status=draft)
  ↓
[Phase 5: 품질 검증] 리뷰어
  → 논리 일관성, 법률 정확성, 증거 충분성, 중립성, 형식 검증
  → 통과 시 → 저지에게 전달 (status=reviewed)
  → 실패 시 → 드래프터에게 반려 + 수정 요청 (최대 2회)
  ↓
[Phase 6: 최종 검토] 저지(팀장)
  → 최종 감정서 검토 + 마스터에게 보고
  → 마스터 승인 → status=approved
  → 마스터가 최종 수정 후 법원 제출 (status=submitted)
  ↓
[Phase 7: 피드백] 저지
  → 감정 결과 → RAG 대도서관 저장 (rag_legal 컬렉션)
  → 법원 판결 결과 수신 시 → 감정 정확도 기록
```

---

## 6. 다른 팀과의 연동

```
감정팀 → 연구팀:
  Scout-Legal이 SW감정 관련 최신 기법/판례 서칭 → 감정팀에 제공
  리서처가 새 감정 방법론 심층 연구 → 코드아이에 반영

감정팀 → 데이터 사이언스 팀:
  감정 사건 데이터 축적 → 유형별 패턴 분석
  유사도 측정 정확도 개선 데이터 제공

감정팀 → 대도서관:
  rag_legal 컬렉션: 감정 사례 + 판례 + 법원 판결 결과
  다른 팀 에이전트가 법률 관련 질문 시 참조 가능
```

---

## 7. 구현 계획 (코덱스 프롬프트 순서)

```
Step 1: 디렉토리 구조 생성 + package.json 업데이트
  → lib/, scripts/, templates/, cases/, context/, migrations/
  → CLAUDE.md 작성

Step 2: DB 스키마 생성
  → migrations/001-appraisal-schema.sql
  → OPS에서 마이그레이션 실행

Step 3: 핵심 라이브러리 구현
  → appraisal-store.js (DB CRUD)
  → similarity-engine.js (코드 유사도 측정)
  → judge.js (오케스트레이션)

Step 4: 에이전트 구현
  → code-eye.js (소스코드 분석)
  → case-hunter.js (판례 서칭)
  → drafter.js (감정서 작성)
  → reviewer.js (품질 검증)

Step 5: 템플릿 + 스크립트
  → appraisal-report.md (감정서 템플릿)
  → start-appraisal.js (감정 시작 CLI)
  → generate-report.js (PDF 생성)

Step 6: 검증
  → 모의 사건으로 전체 프로세스 1회 실행
  → 감정서 초안 품질 확인
```

---

## 8. 안전 원칙

```
① 감정 데이터 보안
  → 소스코드는 cases/ 디렉토리에만 저장
  → GitHub에 push 금지 (.gitignore에 cases/ 추가)
  → 사건 완료 후 소스코드 삭제 (마스터 수동)

② 감정서는 반드시 마스터 최종 검토
  → 에이전트가 작성한 초안은 "초안"일 뿐
  → 마스터가 최종 수정 + 서명 후 법원 제출
  → 에이전트가 직접 법원에 제출하는 일 없음

③ 중립성 원칙
  → 프롬프트에 "객관적 분석" 강조
  → 원고/피고 어느 쪽에도 치우치지 않는 서술
  → 리뷰어가 중립성 검증 항목 포함

④ 법률 용어 정확성
  → context/LEGAL_TERMS.md 법률 용어 사전 참조
  → 잘못된 법률 용어 사용 시 리뷰어가 차단
```
