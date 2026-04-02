# 연구팀 (Research Team) 설계서

> 작성: 메티 (Claude Opus 4.6) + 마스터 (Jay)
> 작성일: 2026-04-02
> 상태: 설계 단계
> v2 역할: 제이 랜드 핵심 엔진 — 기술 서칭→구현/실험→에이전트 반영→필드→피드백

---

## 1. 팀 개요

```
현재: bots/academic (package.json만 존재, "학술보조봇" 설명)
변경: bots/academic → bots/research (리네임)
     "학술보조봇" → "연구팀 — 기술 R&D + 에이전트 진화 엔진"

핵심 역할:
  ① 기술 서칭: 학술 논문, GitHub, 커뮤니티에서 최신 기법 발굴
  ② 코드 구현/실험: 발굴한 기법을 코드로 구현하고 실험
  ③ 에이전트 반영: 실험 결과를 새 에이전트 생성 또는 기존 에이전트 업그레이드
  ④ 필드 투입: 개선된 에이전트를 실제 업무에 투입
  ⑤ 피드백 수집: 성과 데이터를 RAG에 저장, 다음 사이클에 반영
  ⑥ 저성과 분석: 점수 하위 에이전트 심층 분석 → 개선 → 전체 반영

사이클: ①→②→③→④→⑤→⑥→① (무한 루프)
```

---

## 2. 팀 구성 (에이전트)

```
팀장: 프로페서 (Professor) — 연구 총괄, 사이클 오케스트레이션
  역할: 연구 주제 선정, 스카우트 배정, 실험 계획 수립, 결과 평가, 전체 팀 배포 결정
  모델: claude-code/sonnet 또는 anthropic (고품질 판단 필요)

에이전트 1: 스카우트 — 분야별 전문 서칭 에이전트 그룹

  원칙: 스카우트는 분야별 서칭만 담당한다.
        서칭 결과는 프로페서가 판단하여 적절한 팀에 배분한다.
        하나의 서칭 결과가 여러 팀에 동시 적용될 수 있다.
        스카우트는 특정 팀에 종속되지 않는다.

  스카우트-AI (Scout-AI) — AI/멀티에이전트 기술 서칭
    분야: Self-Evolving Agents, LLM 최적화, 프롬프트 엔지니어링, RAG, MCP
    소스: arXiv (cs.MA, cs.AI, cs.CL), GitHub trending, HuggingFace
    모델: groq/llama (빠른 분류) + anthropic (심층 분석)

  스카우트-파이낸스 (Scout-Finance) — 투자/트레이딩 전략 서칭
    분야: 퀀트 전략, 기술적 분석, 시장 미시구조, 리스크 관리, DeFi
    소스: arXiv (q-fin), SSRN, GitHub (trading-strategy), TradingView
    모델: groq/llama + local/qwen2.5-7b

  스카우트-콘텐츠 (Scout-Content) — 콘텐츠/SEO/블로그 서칭
    분야: SEO 트렌드, AEO/GEO, AI 콘텐츠 탐지 우회, 독자 참여율
    소스: Google Search Central 블로그, Moz, Ahrefs 블로그, DEV.to
    모델: local/qwen2.5-7b (빈번한 서칭, 비용 $0)

  스카우트-리걸 (Scout-Legal) — 법률/SW감정 서칭
    분야: SW 감정 방법론, 법원 판례, 디지털 포렌식, 소스코드 분석 기법
    소스: 법률 DB (대법원 종합법률정보), 한국소프트웨어감정평가학회, 학술지
    모델: anthropic (법률 정확성 요구)

  스카우트-데이터 (Scout-Data) — 데이터 사이언스/분석 서칭
    분야: 데이터 파이프라인, 이상 탐지, 시계열 분석, MLOps, 관측성
    소스: arXiv (cs.DB, stat.ML), Databricks/Snowflake 블로그, KDnuggets
    모델: local/qwen2.5-7b

  스카우트-미디어 (Scout-Media) — 영상/편집 기술 서칭
    분야: AI 영상 편집, 자동 자막, 썸네일 생성, CapCut/Twick 기술
    소스: GitHub (video-editing, ffmpeg), YouTube API, arXiv (cs.CV)
    모델: local/qwen2.5-7b

  스카우트-인프라 (Scout-Infra) — 시스템/인프라/보안 서칭
    분야: 로컬 LLM 최적화, macOS 자동화, 보안 패치, 모니터링
    소스: GitHub (mlx, ollama), Homebrew, Apple Developer, CVE 데이터베이스
    모델: local/qwen2.5-7b

  스카우트-마켓 (Scout-Market) — 마케팅/수익화 서칭
    분야: 네이버 인기 키워드, 광고 수익 최적화(애드센스/제휴), SNS 마케팅 전략,
          경쟁 블로그/채널 분석, 콘텐츠 바이럴 패턴, 수익화 모델
    소스: 네이버 키워드 도구, Google Trends, SNS 분석 도구, 마케팅 블로그
    모델: local/qwen2.5-7b (빈번한 서칭, 비용 $0)

  스카우트 공통 패턴:
    입력: 연구 주제 키워드 (프로페서가 배정)
    출력: 논문/프로젝트 요약 리포트 (제목, 핵심, 적용 가능성 점수 0~10)
    저장: research.topics 테이블
    빈도: 각 스카우트 매일 1회 실행 (분야별 시차 배치)
    기존 자산: 아처(archer)의 GitHub/npm 수집 패턴을 스카우트-AI/인프라가 재활용

에이전트 2: 랩러너 (LabRunner) — 코드 구현/실험 전문
  역할: 스카우트가 발굴한 기법을 코드로 구현, 벤치마크 실행
  모델: claude-code/sonnet (코드 구현에 최적)
  입력: 연구 리포트 + 구현 스펙
  출력: 실험 코드 + 벤치마크 결과 + 성공/실패 판정
  작업 디렉토리: bots/research/experiments/

에이전트 3: 테스터 (Tester) — 코드 테스트 전문
  역할: 랩러너가 구현한 코드가 "올바르게 동작하는가" 확인
  모델: claude-code/sonnet (코드 실행/디버깅)
  입력: 실험 코드 + 실험 가설
  출력: 테스트 리포트 (통과율, 실패 케이스, 버그 목록)
  테스트 항목:
    → 문법 검증: node --check, lint, 타입 체크
    → 기능 테스트: 입력→출력 기대값 일치 여부
    → 엣지케이스: 빈 입력, 대량 데이터, 타임아웃 등
    → 회귀 테스트: 기존 기능 훼손 없는지
  원칙: "코드가 깨지지 않는가?"에 집중

에이전트 4: 검증자 (Verifier) — 품질/안전/성능 검증 전문
  역할: 테스트 통과한 코드가 "의미있는 개선인가, 안전한가" 판단
  모델: anthropic (분석적 판단)
  입력: 실험 코드 + 벤치마크 결과 + 테스트 리포트
  출력: 검증 리포트 (성과 유의성, 안전 판정, 배포 권고)
  검증 항목:
    → 성과 검증: before/after 벤치마크 비교, 통계적 유의성
    → 안전 검증: OPS 영향 없는지, 데이터 손상 없는지
    → 비용 검증: 토큰 사용량 변화, 비용 대비 효과
    → 실전 적합성: 실험 환경 vs 실전 환경 차이 분석
  원칙: "이걸 적용해도 되는가?"에 집중

  테스터 vs 검증자 차이:
    테스터: 코드가 작동하는가? (기술적 정확성)
    검증자: 적용할 가치가 있는가? (비즈니스 판단)

에이전트 5: 어댑터 (Adapter) — 에이전트 반영 전문
  역할: 실험 성공 기법을 에이전트 프롬프트/설정에 반영
  모델: anthropic (프롬프트 엔지니어링)
  입력: 실험 결과 + 대상 에이전트 현재 설정
  출력: 수정된 프롬프트/설정 + 변경 이유 + 예상 효과
  주의: 프롬프트 수정만, 코드 수정은 코덱스 프롬프트 생성

에이전트 6: 앰뷸런스 (Ambulance) — 저성과 에이전트 심층 분석
  역할: 점수 하위 20% 에이전트 자동 감지 + 원인 분석 + 개선 방안
  모델: anthropic (분석적 판단)
  입력: Agent Registry 성과 데이터 + 실패 이력
  출력: 진단 리포트 (원인, 개선 방안, 예상 회복 시간)
  연동: 민원게시판 자동 티켓 생성

에이전트 7: 리서처 (Researcher) — 심층 연구 전문
  역할: 스카우트가 발굴한 주제를 깊이 연구 + 논문 리뷰 + 적용 방안 설계
  모델: anthropic (심층 분석, 긴 컨텍스트)
  입력: 스카우트의 서칭 리포트 (상위 후보)
  출력: 심층 연구 리포트 (기법 상세, 장단점, 적용 시나리오, 리스크)
  스카우트와의 차이:
    스카우트 = 넓게 빠르게 서칭 (발굴, 매일)
    리서처 = 깊게 느리게 분석 (심층 연구, 주제당 1~3일)
  예시:
    스카우트-AI: "Self-Evolving Agents 서베이 발견, 적용 가능성 8/10"
    리서처: 서베이 30페이지 분석 → "팀 제이에 적용 가능한 5가지 기법 추출
            + 기법별 구현 난이도/예상 효과/의존성 분석"
  저장: research.topics (심층 분석) + rag_research (대도서관)

에이전트 8: 튜터 (Tutor) — 에이전트 교육 전문
  역할: 저성과 에이전트 재교육 + 신규 에이전트 온보딩 + 스킬 전수
  모델: anthropic (교육적 프롬프트 생성)
  기능:
    A. 재교육 프로그램:
      → 앰뷸런스 진단 기반 맞춤 교육 과정 설계
      → 성공 사례 RAG에서 추출 → "교훈"으로 프롬프트 주입
      → 단계적 난이도 (쉬운 작업 → 본래 작업) 복귀 프로그램
      → 재시험 관리 (통과 기준, 최대 재시도 횟수)
    B. 신규 에이전트 온보딩:
      → 새 에이전트에게 팀 규범/패턴/주의사항 교육
      → 대도서관에서 해당 역할의 성공 패턴 → 초기 프롬프트 반영
      → "선배 에이전트" 노하우를 스킬화하여 전수
    C. 스킬 전수 (포터빌리티):
      → 한 에이전트의 성공 기법을 다른 에이전트에 이식
      → 스킬 패키지 생성 + 적합성 검증 + 배포
      → 스킬 과부하 방지 (에이전트당 최대 10~15개)
  입력: 앰뷸런스 진단 리포트 또는 프로페서의 교육 요청
  출력: 교육 프로그램 + 수정된 프롬프트 + 재시험 결과
  연동: Agent Registry (status 변경), 대도서관 (교육 자료 검색)
```

---

## 3. 디렉토리 구조

```
bots/research/                       ← academic에서 리네임
├── package.json                     ← 업데이트
├── CLAUDE.md                        ← Claude Code 컨텍스트
├── config.json                      ← 런타임 설정
├── context/
│   ├── PROFESSOR_PERSONA.md         ← 팀장 페르소나
│   ├── RESEARCH_PRINCIPLES.md       ← 연구 원칙 (안전, 검증 기준)
│   └── EXPERIMENT_TEMPLATE.md       ← 실험 리포트 템플릿
├── lib/
│   ├── professor.js                 ← 팀장 (오케스트레이션)
│   ├── scout/                       ← 분야별 스카우트
│   │   ├── scout-base.js            ← 공용 서칭 패턴 (추상 클래스)
│   │   ├── scout-ai.js              ← AI/멀티에이전트
│   │   ├── scout-finance.js         ← 투자/트레이딩
│   │   ├── scout-content.js         ← 콘텐츠/SEO
│   │   ├── scout-legal.js           ← 법률/SW감정
│   │   ├── scout-data.js            ← 데이터 사이언스
│   │   ├── scout-media.js           ← 영상/편집
│   │   └── scout-infra.js           ← 시스템/보안
│   ├── lab-runner.js                ← 코드 구현/실험
│   ├── tester.js                    ← 코드 테스트 (문법/기능/엣지/회귀)
│   ├── verifier.js                  ← 품질/안전/성능 검증 (배포 판단)
│   ├── adapter.js                   ← 에이전트 반영
│   ├── ambulance.js                 ← 저성과 분석
│   ├── researcher.js                ← 심층 연구
│   ├── tutor.js                     ← 에이전트 교육/재교육/스킬 전수
│   ├── research-store.js            ← 연구 결과 DB 저장
│   └── experiment-evaluator.js      ← 실험 성과 평가
├── scripts/
│   ├── run-research-cycle.js        ← 연구 사이클 실행 (cron)
│   ├── scan-low-performers.js       ← 저성과 에이전트 스캔
│   ├── generate-research-report.js  ← 주간 연구 리포트
│   └── health-check.js              ← 헬스 체크
├── experiments/                     ← 실험 코드 + 결과
│   ├── 2026-04-02_context-compaction/
│   ├── 2026-04-03_confidence-scoring/
│   └── ...
├── launchd/
│   ├── ai.research.daily.plist      ← 매일 연구 사이클 (22:00)
│   └── ai.research.weekly-report.plist ← 주간 리포트 (일요일)
└── migrations/
    └── 001-research-schema.sql      ← DB 스키마
```

---

## 4. DB 스키마 (PostgreSQL, research 스키마)

```sql
-- 연구 주제 및 결과
CREATE TABLE research.topics (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT,                        -- arxiv, github, community
  source_url TEXT,
  summary TEXT,
  applicability_score NUMERIC(3,1),   -- 0~10 적용 가능성
  status TEXT DEFAULT 'discovered',   -- discovered/experimenting/succeeded/failed/applied
  discovered_by TEXT DEFAULT 'scout',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 실험 기록
CREATE TABLE research.experiments (
  id SERIAL PRIMARY KEY,
  topic_id INTEGER REFERENCES research.topics(id),
  hypothesis TEXT NOT NULL,           -- "컨텍스트 압축으로 토큰 30% 절감"
  method TEXT,                        -- 실험 방법
  code_path TEXT,                     -- experiments/ 하위 경로
  result JSONB,                       -- { success: true, metrics: {...} }
  benchmark_before JSONB,             -- 적용 전 성과
  benchmark_after JSONB,              -- 적용 후 성과
  conclusion TEXT,                    -- 성공/실패 판정 + 이유
  status TEXT DEFAULT 'planned',      -- planned/running/completed/failed
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 에이전트 개선 이력
CREATE TABLE research.agent_improvements (
  id SERIAL PRIMARY KEY,
  experiment_id INTEGER REFERENCES research.experiments(id),
  target_agent TEXT NOT NULL,         -- 'pos-writer', 'aria' 등
  target_team TEXT NOT NULL,          -- 'blog', 'luna' 등
  change_type TEXT,                   -- prompt/config/model/workflow
  change_description TEXT,
  before_score NUMERIC(3,1),
  after_score NUMERIC(3,1),
  applied_at TIMESTAMPTZ,
  rollback_at TIMESTAMPTZ,            -- 롤백 시
  status TEXT DEFAULT 'pending'       -- pending/applied/rolled_back/permanent
);

-- 저성과 에이전트 진단
CREATE TABLE research.diagnoses (
  id SERIAL PRIMARY KEY,
  agent_name TEXT NOT NULL,
  team TEXT NOT NULL,
  current_score NUMERIC(3,1),
  failure_pattern TEXT,               -- 반복 실패 패턴
  root_cause TEXT,                    -- 근본 원인
  recommendation TEXT,                -- 개선 방안
  improvement_id INTEGER REFERENCES research.agent_improvements(id),
  status TEXT DEFAULT 'diagnosed',    -- diagnosed/treating/recovered/archived
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 5. 핵심 워크플로우

### 5-1. 일일 연구 사이클 (매일 22:00 KST)

```
프로페서(팀장) 시작
  ↓
[Phase 1: 서칭] 스카우트
  → arXiv cs.MA/cs.AI 최신 논문 스캔 (web_search API)
  → GitHub trending repos 스캔 (agent, multi-agent 키워드)
  → 결과 → research.topics INSERT (applicability_score 포함)
  → 상위 3건 프로페서에게 보고
  ↓
[Phase 2: 판단] 프로페서
  → 상위 3건 중 실험 가치 있는 1건 선택
  → 실험 계획 수립 → research.experiments INSERT
  → 랩러너에게 실험 지시
  ↓
[Phase 3: 실험] 랩러너
  → 실험 코드 작성 (experiments/ 디렉토리)
  → 벤치마크 실행 (before/after 비교)
  → 결과 → research.experiments UPDATE
  → 테스터에게 테스트 요청
  ↓
[Phase 3.5: 테스트] 테스터
  → 문법/기능/엣지케이스/회귀 테스트 실행
  → 테스트 실패 시 랩러너에게 반려 + 버그 목록 (최대 2회 재시도)
  → 테스트 통과 시 검증자에게 전달
  ↓
[Phase 3.7: 검증] 검증자
  → before/after 벤치마크 비교 + 통계적 유의성 확인
  → OPS 안전성 + 비용 영향 + 실전 적합성 판단
  → 검증 통과 시 어댑터에게 전달
  → 검증 실패 시 프로페서에게 "성과 부족/안전 위험" 보고
  ↓
[Phase 4: 적용] 어댑터 (테스트+검증 모두 통과 시에만)
  → 대상 에이전트 프롬프트/설정 수정안 작성
  → research.agent_improvements INSERT (status=pending)
  → 프로페서 승인 → 적용 (status=applied)
  → 필드 투입 → 성과 모니터링 시작
  ↓
[Phase 5: 피드백] 프로페서
  → 7일 후 성과 비교 (before_score vs after_score)
  → 개선 시 → permanent, 악화 시 → rolled_back
  → 결과 → RAG 대도서관에 저장 (rag_research 컬렉션)
  → 텔레그램 주간 리포트
```

### 5-2. 저성과 에이전트 스캔 (매일 06:00 KST)

```
앰뷸런스 시작
  ↓
[스캔] Agent Registry에서 하위 20% 에이전트 조회
  → score < threshold (동적 계산)
  → 최근 7일 작업 이력 + 실패 패턴 분석
  ↓
[진단] 근본 원인 분석
  → 프롬프트 문제? 모델 한계? 데이터 부족? 워크플로우 비효율?
  → research.diagnoses INSERT
  ↓
[처방] 개선 방안 작성
  → 프로페서에게 보고
  → 민원게시판에 자동 티켓 생성 (type=self_diagnosis)
  ↓
[치료] 프로페서 승인 → 어댑터가 적용
  → 재시험 → 통과 시 풀 복귀, 미통과 시 아카이브
```

---

## 6. 다른 팀과의 연동

```
연구팀 → 블로팀:
  스카우트가 블로그 SEO 트렌드 서칭 → 블로팀 작가 프롬프트에 반영
  앰뷸런스가 포스 품질 하락 감지 → 진단 → 어댑터가 프롬프트 수정

연구팀 → 루나팀:
  스카우트가 트레이딩 전략 논문 서칭 → Chronos 전략에 반영
  랩러너가 백테스트 실험 → 성공 시 루나팀에 새 전략 추가

연구팀 → 감정팀:
  스카우트가 법원 SW 감정 관련 기법 서칭
  앰뷸런스가 감정 정확도 하락 감지 → 분석

연구팀 → 클로드팀:
  아처(기존)의 기술 수집 데이터를 스카우트가 활용
  닥터(기존)의 자동 복구 패턴을 앰뷸런스가 참조

연구팀 → 데이터 사이언스 팀:
  모든 실험 결과 → 데이터팀이 메타 분석
  데이터팀 인사이트 → 연구팀 다음 주제 선정에 반영

연구팀 → 대도서관 (RAG):
  rag_research 컬렉션: 연구 결과 요약 + 적용 여부 + 성과 변화
  다른 팀 에이전트가 검색 가능
```

---

## 7. 기존 자산 재활용

```
아처 (bots/claude/src/archer.js):
  → 이미 GitHub/npm/커뮤니티 기술 수집 구현
  → 스카우트가 아처의 수집 패턴을 참조/확장
  → 아처는 클로드팀에 유지, 스카우트는 연구 전문 서칭

self-improving 스킬 (~/.openclaw/workspace/skills/self-improving/):
  → memory.md(HOT), corrections.md, domains/
  → 연구팀이 이 데이터를 분석하여 시스템 개선에 활용

RAG 경험 저장 (packages/core/lib/experience-store.js):
  → intent-response-result triplet
  → 연구팀이 실패 triplet을 분석하여 개선 방향 도출
```

---

## 8. 구현 계획 (코덱스 프롬프트 순서)

```
Step 1: 디렉토리 구조 생성 + package.json 업데이트
  → bots/academic → bots/research 리네임
  → 디렉토리 구조 생성 (lib/, scripts/, experiments/, launchd/, context/, migrations/)
  → CLAUDE.md 작성

Step 2: DB 스키마 생성
  → migrations/001-research-schema.sql
  → OPS에서 마이그레이션 실행

Step 3: 핵심 라이브러리 구현
  → research-store.js (DB CRUD)
  → experiment-evaluator.js (실험 성과 평가)
  → professor.js (오케스트레이션)

Step 4: 에이전트 구현
  → scout.js (서칭)
  → lab-runner.js (실험)
  → adapter.js (에이전트 반영)
  → ambulance.js (저성과 분석)

Step 5: 스크립트 + cron
  → run-research-cycle.js (일일 사이클)
  → scan-low-performers.js (저성과 스캔)
  → generate-research-report.js (주간 리포트)
  → launchd plist 생성

Step 6: 검증
  → DEV에서 연구 사이클 1회 실행
  → 스카우트 서칭 → 프로페서 판단 → 랩러너 실험 → 결과 확인
  → OPS 배포 + cron 등록
```

---

## 9. 안전 원칙

```
① 코드 수정은 절대 자동 적용하지 않음
  → 연구팀은 프롬프트/설정만 수정 제안
  → 코드 변경 필요 시 코덱스 프롬프트 생성 → 마스터 승인

② 에이전트 반영은 항상 pending → applied 2단계
  → 프로페서 승인 없이 자동 적용 안 됨

③ 7일 모니터링 후 permanent/rolled_back 결정
  → 성과 악화 시 즉시 롤백

④ 실험은 DEV에서만 실행
  → OPS에 직접 실험 코드 실행 금지 (3역할 원칙 준수)

⑤ 토큰 예산 관리
  → 일일 연구 사이클 토큰 상한 설정
  → 스카우트 서칭: 로컬 LLM 우선 (qwen2.5-7b)
  → 프로페서 판단: anthropic (고품질 필요 시만)
```
