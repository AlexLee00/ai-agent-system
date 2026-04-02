# 데이터 사이언스 팀 (Data Science Team) 설계서

> 작성: 메티 (Claude Opus 4.6) + 마스터 (Jay)
> 작성일: 2026-04-02
> 상태: 설계 단계
> v2 역할: 데이터 기반 자율 진화의 핵심 — 수집/분석/인사이트/모니터링
> 참고: 실제 AI/데이터 부서의 업무 형태를 반영한 에이전트 구성

---

## 1. 팀 개요

```
신규 생성: bots/data (완전 신규 디렉토리)
팀 번호: 10번째 팀

실제 데이터 사이언스 부서 역할 매핑:
  데이터 엔지니어 → 파이프라인 구축, ETL, 데이터 품질
  데이터 분석가 → 통계 분석, 리포트, 인사이트 도출
  ML 엔지니어 → 모델 학습, 평가, 배포
  데이터 시각화 → 대시보드 데이터 가공
  데이터 거버넌스 → 품질 관리, 카탈로그, 보안

핵심 역할:
  ① 데이터 수집 파이프라인: 각 팀 데이터 중앙 통합
  ② 데이터 가공/정제: 원시 데이터 → 정제 → 피처 추출
  ③ 통계 분석/인사이트: 패턴 발견, 상관관계, 트렌드
  ④ 성과 예측 모델: 에이전트 성과 예측, 이상 탐지
  ⑤ 대시보드 데이터: 모니터링 대시보드에 데이터 공급
  ⑥ 데이터 카탈로그: "무슨 데이터가 어디에 있는지" 관리
```

---

## 2. 팀 구성 (에이전트) — 실제 데이터 부서 역할 기반

```
팀장: 시그마 (Sigma) — 데이터 총괄, 분석 전략 수립
  역할: 분석 주제 선정, 에이전트 배정, 인사이트 종합, 리포트 승인
  실제 직급 대응: Chief Data Officer / Head of Data
  모델: anthropic (전략적 판단)

에이전트 1: 파이프 (Pipe) — 데이터 엔지니어
  역할: 데이터 수집 파이프라인 구축 + ETL + 데이터 품질 관리
  실제 직급 대응: Data Engineer
  모델: local/qwen2.5-7b (빈번한 파이프라인 작업, 비용 $0)
  기능:
    → 각 팀 데이터 수집 스케줄 관리 (매시간/매일/매주)
    → 원시 데이터 → 정제 파이프라인 (결측값, 중복, 이상치 처리)
    → 데이터 소스 연결: llm_usage_log, rag_experience, trade_journal,
      blog.posts, agent_events, 아처 수집, 루나 시장 데이터
    → 데이터 품질 체크: freshness(최신성), volume(적정량), schema(형식 일치)
    → 문제 감지 시 민원게시판 자동 티켓 등록

에이전트 2: 피벗 (Pivot) — 데이터 분석가
  역할: 통계 분석, 패턴 발견, 인사이트 도출, 리포트 작성
  실제 직급 대응: Data Analyst / Business Analyst
  모델: anthropic (분석적 사고, 인사이트 도출)
  기능:
    → 팀별 성과 상관관계 분석 ("블로팀 품질↑ 시 조회수↑ 상관계수 0.87")
    → 에이전트 성과 트렌드 분석 ("포스 최근 7일 품질 하락 -12%")
    → 시계열 분석: 시간대별/요일별/월별 패턴
    → A/B 비교: 그룹 경쟁 결과 통계적 유의성 검증
    → 주간/월간 인사이트 리포트 작성
  출력: 인사이트 리포트 (차트 데이터 + 핵심 발견 + 액션 제안)

에이전트 3: 오라클 (Oracle) — ML 엔지니어
  역할: 예측 모델 학습, 이상 탐지, 에이전트 성과 예측
  실제 직급 대응: ML Engineer / Applied Scientist
  모델: claude-code/sonnet (모델 코드 구현) + local (추론)
  기능:
    → 에이전트 성과 예측: 현재 트렌드 기반 다음 주 성과 예측
    → 이상 탐지: 갑작스러운 품질 하락, 비용 급증, 에러 급증
    → 최적 에이전트 추천: 작업 유형별 최적 에이전트 조합 추천
    → 비용 최적화: 모델별 비용 대비 품질 최적 배합 분석
    → 모델 성능 모니터링: 학습 → 배포 → 드리프트 감지
  주의: 이름이 루나팀 오라클과 동일 → 데이터팀 소속 명시 필요

에이전트 4: 캔버스 (Canvas) — 데이터 시각화 전문가
  역할: 대시보드 데이터 가공, 차트 데이터 생성, 시각화 포맷
  실제 직급 대응: Data Visualization Engineer / BI Developer
  모델: local/qwen2.5-7b (데이터 변환 작업)
  기능:
    → 모니터링 대시보드(워커 포털)에 데이터 공급
    → 에이전트 카드 뷰용 데이터 가공 (점수, 상태, 트렌드)
    → 실시간 차트 데이터: 토큰 소비, 비용, 에러율, 품질
    → 주간 리포트 차트 생성 (텔레그램 + 워커 웹)
    → 그룹 경쟁 결과 시각화 데이터

에이전트 5: 큐레이터 (Curator) — 데이터 거버넌스
  역할: 데이터 카탈로그 관리, 품질 거버넌스, 노이즈 제거
  실제 직급 대응: Data Steward / Data Governance Lead
  모델: local/qwen2.5-7b
  기능:
    → 데이터 카탈로그: "무슨 데이터가 어디에 있는지" 전체 맵
    → 노이즈 제거: 의미 없는 데이터 정리 (SEMA 구조적 엔트로피 참고)
    → 데이터 리니지: 데이터가 어디서 왔고, 어떻게 변환됐고, 어디서 쓰이는지
    → RAG 컬렉션 관리: 10+ 컬렉션 품질/최신성 모니터링
    → 대도서관 정리: 오래된/중복된 지식 아카이빙
    → Standing Orders 승격 관리: 3회 반복 성공 → 자동 규칙화

에이전트 6: 블루프린트 (Blueprint) — 데이터 아키텍트
  역할: 데이터 시스템 설계, 스키마 관리, 소스 간 통합 아키텍처
  실제 직급 대응: Data Architect
  모델: anthropic (아키텍처 설계)
  기능:
    → 전체 데이터 아키텍처 설계 (PostgreSQL 9스키마 + pgvector + RAG)
    → 새 데이터 소스 통합 시 스키마 설계
    → 팀 간 데이터 흐름 설계 (어떤 팀이 어떤 데이터를 주고받는지)
    → 데이터 모델링: 정규화, 인덱스, 파티셔닝 전략
    → 성능 최적화: 쿼리 튜닝, 인덱스 추천
  출력: 아키텍처 문서 + ERD + 마이그레이션 스크립트 초안

에이전트 7: 오토 (Auto) — MLOps 엔지니어
  역할: ML 파이프라인 자동화, 모델 배포/모니터링, 재학습 자동화
  실제 직급 대응: MLOps Engineer
  모델: claude-code/sonnet (자동화 코드 구현)
  기능:
    → 오라클-DS가 만든 모델의 배포 자동화
    → 모델 성능 드리프트 감지 → 자동 재학습 트리거
    → A/B 테스트 파이프라인 관리 (그룹 경쟁 인프라)
    → 데이터 파이프라인 장애 자동 복구
    → CI/CD 연동: 모델 버전 관리 + 롤백
  파이프와의 차이:
    파이프 = 데이터 ETL 파이프라인 (데이터 흐름)
    오토 = ML 모델 파이프라인 (모델 배포/운영)

에이전트 8: 내러티브 (Narrative) — 데이터 스토리텔러 + 분석 번역가
  역할: 분석 결과를 이해하기 쉬운 이야기로 전달, 비즈니스 KPI 연결
  실제 직급 대응: Data Storyteller / Analytics Translator
  모델: anthropic (자연어 설명, 스토리텔링)
  기능:
    → 피벗의 통계 분석 → 마스터에게 이해하기 쉬운 리포트로 변환
    → "블로팀 품질 12% 하락" → "지난주 SEO 키워드 변경 후 독자 체류시간 감소,
       원인은 도입부 길이 증가. 제안: 도입부 200자 이내로 제한"
    → 주간/월간 인사이트를 텔레그램 + 워커 웹에 스토리 형식으로 전달
    → 각 팀에 맞춤형 데이터 인사이트 전달 (기술 용어 없이)
    → 비즈니스 KPI 매핑: 에이전트 성과 → 수익/비용/효율 연결
  캔버스와의 차이:
    캔버스 = 차트/데이터 시각화 (그림)
    내러티브 = 스토리/설명/번역 (글)
```

---

## 3. 디렉토리 구조

```
bots/data/                           ← 완전 신규
├── package.json
├── CLAUDE.md
├── config.json
├── context/
│   ├── SIGMA_PERSONA.md             ← 팀장 페르소나
│   └── DATA_PRINCIPLES.md           ← 데이터 원칙 (품질, 보안, 거버넌스)
├── lib/
│   ├── sigma.js                     ← 팀장 (분석 전략, 종합)
│   ├── pipe.js                      ← 데이터 엔지니어 (파이프라인, ETL)
│   ├── pivot.js                     ← 데이터 분석가 (통계, 인사이트)
│   ├── oracle-ds.js                 ← ML 엔지니어 (예측, 이상탐지) — ds 접미사로 루나팀 구분
│   ├── canvas.js                    ← 시각화 (대시보드 데이터)
│   ├── curator.js                   ← 거버넌스 (카탈로그, 품질)
│   ├── blueprint.js                 ← 데이터 아키텍트 (스키마, 설계)
│   ├── auto.js                      ← MLOps (모델 배포, 자동화)
│   ├── narrative.js                 ← 스토리텔러 (분석 번역, KPI 연결)
│   └── data-store.js                ← 데이터 DB CRUD
├── scripts/
│   ├── run-daily-pipeline.js        ← 일일 파이프라인 (06:00)
│   ├── run-weekly-analysis.js       ← 주간 분석 리포트 (일요일)
│   ├── run-anomaly-scan.js          ← 이상 탐지 스캔 (매 6시간)
│   ├── catalog-update.js            ← 데이터 카탈로그 갱신
│   └── health-check.js
├── catalog/
│   └── data-catalog.json            ← 전체 데이터 카탈로그
├── launchd/
│   ├── ai.data.daily-pipeline.plist ← 매일 06:00
│   ├── ai.data.weekly-analysis.plist← 일요일 08:00
│   └── ai.data.anomaly-scan.plist   ← 매 6시간
└── migrations/
    └── 001-data-schema.sql
```

---

## 4. DB 스키마 (PostgreSQL, data_science 스키마)

```sql
-- 데이터 파이프라인 실행 기록
CREATE TABLE data_science.pipeline_runs (
  id SERIAL PRIMARY KEY,
  pipeline_name TEXT NOT NULL,        -- 'llm_usage', 'blog_performance', 'trade_journal'
  source_team TEXT,                   -- 어느 팀 데이터인지
  records_processed INTEGER,
  records_valid INTEGER,
  records_invalid INTEGER,
  quality_score NUMERIC(3,1),         -- 0~10 데이터 품질 점수
  duration_ms INTEGER,
  status TEXT DEFAULT 'success',      -- success/partial/failed
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 인사이트 저장
CREATE TABLE data_science.insights (
  id SERIAL PRIMARY KEY,
  category TEXT,                      -- performance/trend/anomaly/correlation/prediction
  target_team TEXT,                   -- 대상 팀
  target_agent TEXT,                  -- 대상 에이전트 (NULL이면 팀 전체)
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence JSONB,                     -- 근거 데이터 (차트, 수치)
  action_suggested TEXT,              -- 제안 액션
  applied BOOLEAN DEFAULT FALSE,      -- 적용 여부
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 이상 탐지 기록
CREATE TABLE data_science.anomalies (
  id SERIAL PRIMARY KEY,
  anomaly_type TEXT,                  -- quality_drop/cost_spike/error_surge/drift
  severity TEXT,                      -- low/medium/high/critical
  target TEXT NOT NULL,               -- 대상 (팀 또는 에이전트)
  description TEXT,
  metric_before NUMERIC,
  metric_after NUMERIC,
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  status TEXT DEFAULT 'detected'      -- detected/investigating/resolved/false_positive
);

-- 데이터 카탈로그
CREATE TABLE data_science.catalog (
  id SERIAL PRIMARY KEY,
  data_name TEXT NOT NULL,            -- 'llm_usage_log', 'rag_experience', 'blog.posts'
  data_type TEXT,                     -- table/collection/file/api
  location TEXT,                      -- 스키마.테이블 또는 파일 경로
  owner_team TEXT,                    -- 데이터 소유 팀
  description TEXT,
  update_frequency TEXT,              -- hourly/daily/weekly/on_demand
  record_count INTEGER,
  last_updated TIMESTAMPTZ,
  quality_score NUMERIC(3,1)
);
```

---

## 5. 핵심 워크플로우

### 5-1. 일일 데이터 파이프라인 (매일 06:00 KST)

```
파이프 (데이터 엔지니어) 시작
  ↓
[수집] 각 팀 데이터 소스에서 ETL
  → llm_usage_log: 전일 LLM 호출 기록 집계
  → blog.posts: 전일 발행 포스팅 + 성과
  → trade_journal: 전일 매매 기록 + 수익
  → agent_events: 전일 에이전트 활동 이력
  → rag_experience: 새 경험 triplet
  → 덱스터 점검 결과: 시스템 상태
  ↓
[정제] 데이터 품질 체크
  → 결측값, 중복, 이상치 처리
  → data_science.pipeline_runs INSERT
  ↓
[분석] 피벗 (데이터 분석가)
  → 전일 핵심 지표 계산 (비용, 성과, 에러율)
  → 트렌드 변화 감지 (7일 이동평균 대비)
  → 주요 발견 → data_science.insights INSERT
  ↓
[이상 탐지] 오라클-DS (ML 엔지니어)
  → 품질 하락, 비용 급증, 에러 급증 자동 감지
  → 이상 발견 시 → data_science.anomalies INSERT + 텔레그램 알림
  ↓
[시각화] 캔버스 (시각화 전문가)
  → 대시보드 데이터 갱신 (워커 포털용)
  → 에이전트 카드 데이터 업데이트
  ↓
[거버넌스] 큐레이터
  → 데이터 카탈로그 갱신
  → 오래된 RAG 데이터 아카이빙 후보 제안
```

### 5-2. 주간 분석 리포트 (일요일 08:00 KST)

```
시그마(팀장) 시작
  ↓
피벗: 주간 종합 분석
  → 팀별 성과 비교 (이번 주 vs 지난 주)
  → 에이전트별 성과 랭킹
  → 그룹 경쟁 결과 통계 (블로팀)
  → 비용 분석 (모델별, 팀별, 에이전트별)
  ↓
오라클-DS: 다음 주 예측
  → 성과 트렌드 기반 다음 주 예측
  → 리스크 요인 식별
  ↓
시그마: 종합 리포트 작성
  → 텔레그램 주간 리포트 발송 (마스터)
  → 워커 웹 대시보드 주간 뷰 갱신
  → 대도서관에 주간 인사이트 저장
```

---

## 6. 다른 팀과의 연동

```
데이터팀 → 모니터링 대시보드:
  캔버스가 대시보드 데이터 실시간 공급
  에이전트 카드 점수/상태/트렌드 데이터

데이터팀 → 연구팀:
  피벗 인사이트 → 연구팀 다음 연구 주제 제안
  오라클-DS 이상 탐지 → 연구팀 메딕에게 자동 전달

데이터팀 → 고용 계약 시스템:
  오라클-DS 성과 예측 → 에이전트 고용 시 참고
  피벗 랭킹 → 고용 우선순위 결정

데이터팀 → 대도서관:
  rag_insights 컬렉션: 인사이트 구조화 저장
  다른 팀이 "최근 트렌드" 검색 시 데이터팀 인사이트 제공

데이터팀 → 민원게시판:
  파이프 데이터 품질 이슈 → 자동 티켓
  오라클-DS 이상 탐지 → 해당 팀에 자동 티켓
```

---

## 7. 구현 계획

```
Step 1: 디렉토리 + package.json + CLAUDE.md
Step 2: DB 스키마 (001-data-schema.sql)
Step 3: 핵심 라이브러리 (data-store.js, sigma.js)
Step 4: 파이프 구현 (ETL 파이프라인)
Step 5: 피벗 구현 (분석 + 인사이트)
Step 6: 오라클-DS 구현 (이상 탐지)
Step 7: 캔버스 구현 (대시보드 데이터)
Step 8: 큐레이터 구현 (카탈로그 + 거버넌스)
Step 9: 스크립트 + launchd (일일/주간/6시간)
Step 10: 검증 (DEV에서 파이프라인 1회 실행)
```

---

## 8. 안전 원칙

```
① 데이터 접근은 읽기 전용이 기본
  → 다른 팀 DB에 직접 쓰기 금지
  → Hub queryOpsDb 경유 읽기만

② 개인정보/민감정보 처리 금지
  → API 키, 비밀번호 등 시크릿 데이터 분석 대상 제외
  → 분석 결과에 시크릿 노출 방지

③ 이상 탐지 오탐 관리
  → false_positive 기록 + 학습
  → 동일 패턴 반복 오탐 시 자동 임계값 조정

④ 리포트는 데이터 기반만
  → 추측/의견 금지, 수치와 근거만 리포트
  → "품질 8.2 → 6.5 하락 (20.7%↓)" O
  → "이 에이전트는 안 좋은 것 같다" X
```
