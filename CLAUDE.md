# 팀 제이 (Team Jay) 아키텍처

> 전략문서 상세: team-jay-strategy.md 참조
> 최종 업데이트: 2026-03-11

## 명칭 체계

| 구분 | 이름 | 설명 |
|------|------|------|
| 마스터 | Alex | 사람 (전략 설정, 예외 승인) |
| 시스템 | 팀 제이 | ai-agent-system 전체 |
| 메인봇 | 제이 (Jay) | 총괄 허브 |
| SKA팀장 | 스카 | 매출관리 + 예약관리 |
| 시스템팀장 | 클로드 | 시스템 개선·유지보수 |
| 투자팀장 | 루나 | 자동매매 (암호화폐 실투자, 국내외장 모의) |

## 팀 제이 6대 원칙

1. **자율과 통제의 균형** — 봇은 진화하되, 비용과 권한은 통제
2. **감지와 판단의 분리** — 감지(덱스터)와 판단(팀장)을 분리
3. **정합성 우선** — 실행은 빠르게, 데이터 정합성은 절대 보존
4. **기록이 곧 진화** — 모든 판단을 추적. 기록 없이 개선 없음
5. **비용 의식** — 무료 모델 최대 활용, 유료는 가치 있는 곳에만
6. **노드 단위 업무 분리** — 모든 파이프라인을 노드로 분해. 결합도 0, RAG 간접 연결

## 3계층 에이전트 모델

```
Layer 3: 마스터 (Alex) — 전략 설정, 예외 승인
Layer 2: 팀장 봇 (LLM) — 스카/클로드/루나, 자율 판단·조율
Layer 1: 팀원 봇 (규칙) — 앤디/지미/덱스터/아리아 등, 실행·보고
```

## 팀별 LLM 모델 (2026-03-11 확정)

| 팀 | 메인 모델 | 폴백 | 특징 |
|----|----------|------|------|
| 루나팀 | Groq dual (oss-20b vs scout) | → gpt-4o (25만) | 무료 경쟁, 최종 폴백 유료 |
| 블로팀 | gpt-4o (25만) | → gpt-4o-mini → flash | 품질 최우선 |
| 클로드팀 | gpt-4o (25만) | → gpt-4o-mini → scout | Sonnet 제거, 무료화 |
| 스카팀 | Groq 무료 | — | 예외 상황에서만 LLM |
| 워커팀 | (미정) | — | 구현 전 |

월 비용: 텍스트 $0 (전부 무료 한도 내) + 이미지 ~$8 = **~$8/월**

## 소통 구조

| 경로 | 기술 |
|------|------|
| 마스터 ↔ 팀장 | 텔레그램 Forum Topic |
| 팀장 ↔ 팀장 | OpenClaw sessions_send |
| 팀장 ↔ 팀원 | State Bus (agent_events / agent_tasks) |

### 의사소통 가드레일 (위반 시 거부)
- Layer 1 → Layer 3 직접 보고 금지 (반드시 Layer 2 경유)
- 팀 간 직접 통신 금지 (OpenClaw sessions_send 경유만 허용)
- Layer 1이 LLM 직접 호출 금지 (팀장 경유만 허용)
- 긴급 상황 시에만 Layer 1 → Layer 3 텔레그램 직접 알림 허용 (alert_level: 4 이상)

## State Bus 테이블 (state.db)

기존 유지:
- `agent_state` — 에이전트 상태
- `pickko_lock` — 픽코 접속 잠금
- `pending_blocks` — 즉시 차단 큐

Day 1 추가 (2026-03-06):
- `agent_events` — 팀원→팀장 이벤트 보고 (emitEvent, getUnprocessedEvents, markEventProcessed)
- `agent_tasks` — 팀장→팀원 작업 지시 (createTask, getPendingTasks, completeTask, failTask)

## 루나팀 실투자 보호

- 헤파이스토스: 진입 시 Spot OCO 주문으로 TP/SL 거래소 설정 필수 (Day 1 구현 완료)
- 현재: TP +6%, SL -3% 고정 비율. 향후 네메시스가 동적 산출 예정
- API 장애 시: 신규 진입 중단 (포지션 보호 모드), 기존 포지션은 거래소 TP/SL로 보호
- `tp_sl_set = true` 확인 후에만 포지션 활성으로 간주

## 최근 주요 변경 (2026-03-08)

- **capital-manager.js**: 루나팀 자본 관리 완전체 (잔고 체크/포지션 사이징/서킷 브레이커)
- **시그널 융합**: confidence score 기반 가중 의사결정 + LLM 자기반성 주간 리뷰
- **덱스터 Phase 3**: 이벤트 발행 → 클로드 팀장 판단 → 독터 복구 + Emergency 폴백
- **n8n fan-out → 순차 체인**: 409 Conflict + 메모리 누수 수정
- **RAG pgvector 마이그레이션**: Python rag-system deprecated, packages/core/lib/rag.js 전환
- **pg-pool 자동 재연결**: exponential backoff + _safeQuery 3회 재시도 + Graceful Shutdown
- **telegram Rate Limit**: 429 retry_after 준수 + Throttle (1500ms) + 배치 (2초 윈도우)

## 안정화 기간 (6주, ~4월 중순 맥미니 도착까지)

- 1주차: 핵심 기반 구축 — State Bus + TP/SL ✅
- 2주차: 스카팀 LLM(Groq) 적용 (Shadow Mode 병렬 검증) ✅
- 3주차: 클로드팀 LLM(Sonnet) 적용 + 덱스터 Phase 3 ✅
- 4주차: 루나팀 자본관리 + 시그널 융합 + 코어 인프라 강화 ✅ (현재)
- 5~6주차: 전체 통합 안정화 + 맥미니 이관

## LLM 모델 최적화 원칙 (2026-03-11 확정)

### 무료 한도 활용
- OpenAI 대형 (gpt-4o): 25만 토큰/일 무료 → 핵심 판단에만 사용
- OpenAI 소형 (gpt-4o-mini): 250만 토큰/일 무료 → 분류/요약/보조에 사용
- Groq (scout/oss-20b): 무료 무제한 → 루나팀 메인
- Gemini (2.5-flash): 무료 → 3순위 폴백

### 에이전트별 모델 라우팅
| 그룹 | 에이전트 | 메인 | 폴백 |
|------|----------|------|------|
| 루나 전용 | luna | gpt-4o (25만) | → scout |
| Groq 경쟁 | nemesis, oracle | dual (oss-20b vs scout) | → gpt-4o |
| Mini 우선 | hermes, sophia, zeus, athena | gpt-4o-mini (250만) | → scout → gpt-4o |
| 속도 우선 | argos 등 | scout (Groq) | → gpt-4o-mini |
| 블로 메인 | 포스, 젬스 | gpt-4o (25만) | → gpt-4o-mini → flash |
| 블로 보조 | 스타, 품질검증 | gpt-4o-mini (250만) | → flash |
| 클로드 리드 | Claude Lead | gpt-4o (25만) | → gpt-4o-mini → scout |

### 폴백 원칙
- 모든 LLM 호출에 최소 2단계 폴백 체인 필수
- 최종 폴백이 없는 throw 금지 (반드시 안전망 존재)
- 폴백 시 logMeta에 fallback=true 기록

### 이미지 생성
- 메인: gpt-image-1 quality=medium (~$8/월)
- 맥미니 도착 후: ComfyUI FLUX 셀프호스팅 ($0)

### 비용 로깅
- 모든 LLM 호출은 llm-logger.js 경유 (토큰/비용 DB 추적)
- 긴급 차단: billing-guard.js (일$10/시$3/건$1 초과 시 전체 차단)

## DB 단일화 원칙

- 운영 DB: PostgreSQL (jay DB) 단일 — 별도 DB 추가 지양
- 벡터 DB: pgvector 확장 (PostgreSQL 내) — 별도 벡터 DB(ChromaDB 등) 금지
- 상태 파일: 가능하면 PostgreSQL 테이블로 전환 (JSON 파일 기반 지양)
- 스키마 분리: `reservation` (스카), `investment` (루나), `blog` (블로), `claude` (클로드)

## n8n 워크플로우 원칙

- 스카팀: 이미 n8n 6개 워크플로우 운영
- 블로팀: Phase 4에서 n8n 오케스트레이션 적용 예정
- 루나팀/클로드팀: 노드화 후 n8n 전환 예정
- n8n 아키텍처: fan-out 금지, 순차 체인 구조 사용 (n8n 2.x 안정성)
- 노드 간 데이터 전달: RAG 중간 저장소 (pgvector) 경유

---

# CLAUDE.md — Claude Code 세션 규칙

> 이 파일은 Claude Code (CLI)가 세션 시작 시 자동으로 읽는 지시 파일입니다.
> 모든 세션에서 아래 규칙이 최우선 적용됩니다.

---

## PATCH_REQUEST.md 처리 규칙

### 규칙 1: 세션 시작 시 자동 확인
- 세션이 시작될 때 프로젝트 루트에 `PATCH_REQUEST.md`가 존재하는지 확인합니다.
- 파일이 존재하면 반드시 내용을 읽고, 사용자에게 요약하여 알립니다.
- 단, 사용자가 이미 다른 작업을 지시했다면 해당 작업 완료 후 알립니다.

### 규칙 2: 패치 처리 순서
1. `critical` / `high` 보안 취약점 → 즉시 조치 (사용자 확인 후)
2. Breaking 패키지 업데이트 → 사용자 확인 필수 (변경사항 검토)
3. 일반 패키지 업데이트 → 사용자 확인 후 일괄 처리
4. LLM API 변경사항 → 영향받는 코드 파악 후 보고
5. AI 기술 트렌드 → 참고만 (즉각 조치 불필요)

### 규칙 3: 처리 완료 후 파일 처리
- 모든 패치 작업 완료 후 `PATCH_REQUEST.md` 파일을 삭제합니다.
- 단, 미완료 항목이 있으면 해당 항목만 남기고 파일을 업데이트합니다.

### 규칙 4: 자동 처리 금지 항목
- 실제 라이브 서버에 영향을 주는 변경 (반드시 사용자 확인)
- Breaking change가 있는 메이저 버전 업그레이드
- 프로덕션 환경 변수 및 API 키 변경

---

## 팀 버스 (Team Bus) 규칙

### 구조
- DB 위치: `~/.openclaw/workspace/claude-team.db`
- 관리 모듈: `bots/claude/lib/team-bus.js`
- 마이그레이션: `bots/claude/migrations/001_team_bus.js`

### 팀원 상태 확인
```bash
# 클로드팀 전체 상태
node bots/claude/scripts/team-status.js
# 또는
cd bots/claude && npm run status
```

### 패치 현황 확인
```bash
node bots/claude/scripts/patch-status.js
# 또는
cd bots/claude && npm run patch:status
```

---

## 클로드팀 봇 실행 명령

```bash
cd bots/claude

# 덱스터 (시스템 점검)
npm run dexter              # 기본 점검
npm run dexter:full         # 전체 점검 (npm audit 포함)
npm run dexter:fix          # 자동 수정 + 텔레그램 알림
npm run dexter:daily        # 일일 보고 (텔레그램)
npm run dexter:checksums    # 체크섬 갱신 (코드 수정 후)
npm run dexter:quick        # 퀵체크 수동 실행 (5분 주기: ai.claude.dexter.quick)

# 패턴 이력 초기화
node src/dexter.js --clear-patterns --label=<레이블>   # 특정 이슈 이력 삭제
node src/dexter.js --clear-patterns --check=<체크명>    # 특정 체크 모듈 이력 삭제
node src/dexter.js --clear-patterns --all               # 전체 이력 삭제

# 아처 (기술 인텔리전스)
npm run archer              # 데이터 수집 + Claude 분석 (텔레그램 없음)
npm run archer:telegram     # 데이터 수집 + Claude 분석 + 텔레그램
npm run archer:fetch-only   # 데이터 수집만 (디버그)

# 유틸
npm run migrate             # claude-team.db 마이그레이션
npm run status              # 팀 상태 콘솔
npm run patch:status        # 패치 현황 콘솔
```

---

## 공통 유틸리티 — 반드시 사용 (신규 팀/봇 포함)

### 시간 유틸리티: `packages/core/lib/kst.js`
새 팀·봇·스크립트를 추가할 때 **시간/날짜 관련 코드는 반드시 kst.js를 사용**한다.

```js
// CJS (대부분의 봇)
const kst = require('../../../packages/core/lib/kst');

// ESM (루나팀 등)
import { createRequire } from 'module';
const kst = createRequire(import.meta.url)('../../../packages/core/lib/kst');
```

| 금지 패턴 | 대체 |
|-----------|------|
| `new Date().toISOString().slice(0,10)` | `kst.today()` |
| `new Date(Date.now() + 9*3600*1000)` | `kst.today()` / `kst.datetimeStr()` |
| `new Date().toLocaleString('ko-KR', {timeZone:'Asia/Seoul'})` | `kst.toKST(new Date())` |
| `new Date().toLocaleTimeString(...)` | `kst.timeStr()` |

### launchd plist 시간 규칙
**macOS launchd `StartCalendarInterval`은 로컬 시간(KST) 기준** — UTC 변환 금지.
KST 시각을 그대로 `Hour` / `Minute`에 지정한다.

```xml
<!-- KST 09:00 실행 예시 -->
<key>StartCalendarInterval</key>
<dict>
  <key>Hour</key><integer>9</integer>      <!-- KST 09 그대로, UTC 00 아님 -->
  <key>Minute</key><integer>0</integer>
</dict>
```

## 노드화 아키텍처 원칙 (6대 원칙 #6)

모든 팀의 파이프라인은 노드 단위로 설계한다.

### 핵심 규칙
- 노드 간 결합도 0 — RAG 중간 저장소로만 간접 연결
- 노드 단위 실패 격리 — 한 노드 실패해도 다른 노드 결과 보존
- 실패한 노드만 재실행 (전체 파이프라인 재실행 금지)
- 모든 노드 입출력을 RAG에 기록 (감사 추적)
- 새 기능 추가 시 기존 노드에 끼워넣지 말고 독립 노드로 추가

### 팀별 노드 현황
| 팀 | 노드 수 | 상태 |
|----|---------|------|
| 블로팀 | 24개 (N01~N53) | 설계 완료 |
| 루나팀 | 19개 (L01~L34) | 설계 완료 |
| 클로드팀 | 16개 (C01~C24) | 설계 완료 |
| 워커팀 | 12개 (W01~W23) | 설계 완료 |
| 스카팀 | 5개 (S01~S05) | n8n 운영 중 |

### RAG 중간 저장소 패턴
```js
await rag.store(namespace, content, metadata, botName);
// namespace: 'blog_pipeline_store' | 'investment_pipeline_store' | 'monitor_pipeline_store' | 'worker_pipeline_store'
// metadata 필수 필드: session_id, node_id, node_type, timestamp, status, duration_ms
```

→ 상세: 노션 "팀 제이 노드화 아키텍처" 페이지 참조

---

## 절대 규칙 (변경 불가)

- 시스템 기본 언어: **한국어** (코드 주석, 로그, 알림 포함)
- 봇 이름 변경 불가: 클로드, 스카, 루나, 덱스터, 아처 등
- OPS 전환은 반드시 사용자 확인 후에만
- secrets.json, API 키 파일은 절대 Git 커밋 금지
- 실투자 보호: 헤파이스토스/한울 진입 시 TP/SL 거래소 설정 필수. tp_sl_set 확인 전 포지션 활성화 금지
- DB/코드 파일 자동 삭제 금지: state.db, ska.duckdb, .js, .py 파일은 어떤 봇도 자동 삭제 불가
- 팀 경계 침범 금지: 타 팀 DB 직접 접근 금지. State Bus의 agent_events/agent_tasks 경유만 허용
- LLM 판단으로 OPS 데이터 직접 수정 금지: LLM 결과를 OPS DB에 직접 쓰기 금지, 규칙 기반 실행봇 경유 필수
- DEV/OPS 데이터 격리: MODE=dev에서 OPS 데이터 접근 금지, MODE=ops에서 실험적 코드 실행 금지
- **소스코드 접근 권한 제한** (2026-03-11):
  - 소스코드(.js/.ts/.py/.sh) 수정 권한: **마스터(Alex)와 Claude Code만** — 모든 봇(팀장 포함) 절대 금지
  - 봇이 오류를 감지하면 소스코드를 수정하지 말고 텔레그램으로 보고만 할 것
  - `fs.writeFileSync`로 코드 파일 덮어쓰기 금지 (`packages/core/lib/file-guard.js` 참조)
  - `exec`/`spawn`으로 `git commit/push` 실행 금지
  - 허용: 설정 읽기, 데이터 파일 읽기/쓰기(JSON 상태·로그·DB), 산출물 쓰기(HTML·TXT·이미지)
  - **덱스터(dexter) 예외**: `DEXTER_ALLOWED_PATTERNS` 화이트리스트 파일만 수정 허용
    - `.checksums.json` 갱신 (git 커밋 변경 확인 후 `fixChecksums` 실행)
    - `*.lock` 파일 삭제 (프로세스 종료 확인 후)
    - `dexter-state.json` / `dexter-mode.json` (자기진단·모드 상태)
    - 로그 파일(`*.log`) — 로테이션 시 비우기
    - ALLOWED_AUTOFIX_ACTIONS 범위 외 수정 시도 → `reportInsteadOfFix()` 경고 발송

---

## 개발 루틴 (대규모/핵심 개발 시 필수)

### 세션 시작 루틴
1. CLAUDE.md 읽기 (프로젝트 규칙)
2. docs/SESSION_CONTEXT_INDEX.md 읽기 (공통 문서/팀별 진입점 인덱스)
3. docs/DOCUMENTATION_SYSTEM.md 읽기 (문서 체계/읽는 순서/업데이트 규칙)
4. docs/SESSION_HANDOFF.md 읽기 (이전 세션 컨텍스트)
5. docs/KNOWN_ISSUES.md 확인 (현재 알려진 문제)
6. docs/PLATFORM_IMPLEMENTATION_TRACKER.md 확인 (현재 구현 상태와 빠른 찾기)
7. git status로 현재 상태 확인

### 세션 마무리 루틴
1. Git 커밋 (미커밋 변경사항 정리)
2. docs/work-history.md 업데이트 (오늘 한 일 — 사실 중심)
3. docs/DEV_LOG.md 업데이트 (세션 요약 — 맥락 중심)
4. docs/DEV_VLOG.md 업데이트 (연구/회고 — 서술형)
5. docs/dev-journal.md 업데이트 (중요 결정/인사이트 — 장기 연구용)
6. docs/TEST_RESULTS.md 업데이트 (테스트 실행했다면)
7. docs/CHANGELOG.md 업데이트 (기능 추가/변경이 있었다면)
8. docs/KNOWN_ISSUES.md 업데이트 (새로 발견된 이슈가 있다면)
9. docs/SESSION_HANDOFF.md 작성 (다음 세션에 전달할 컨텍스트)
10. Git 최종 커밋 + push — 커밋 메시지: `docs: 세션 마감 문서 업데이트 (YYYY-MM-DD)`

### 작업 중 규칙
- 의미 있는 단위로 자주 Git 커밋 (한 번에 몰아서 ❌)
- 커밋 메시지: `feat:`, `fix:`, `docs:`, `chore:` 접두사 + 한국어
- 새로운 기능/변경 시 해당 테스트 작성 또는 실행

### 개발 문서 목적

| 문서 | 목적 | 작성 시점 |
|------|------|----------|
| work-history.md | 무엇을 했는가 (사실, 변경 파일, 테스트 결과) | 매 작업 완료 즉시 |
| dev-journal.md | 왜 이렇게 결정했는가 (연구/논문/발표용) | 중요 결정/인사이트 시 |
| SESSION_CONTEXT_INDEX.md | 공통 규칙/진입점/운영 설정 인덱스 | 공통 구조 변경 시 |
| DOCUMENTATION_SYSTEM.md | 문서 역할/읽는 순서/통폐합 기준 | 문서 체계 변경 시 |
| SESSION_HANDOFF.md | 다음 세션에 전달할 맥락 (기억 이전) | 매 세션 종료 시 |
| DEV_LOG.md | 세션 단위 사실+맥락 기록 | 매 세션 종료 시 |
| DEV_VLOG.md | 세션 단위 서술형 연구/회고 | 매 세션 종료 시 |
| TEST_RESULTS.md | 테스트 결과 누적 | 테스트 실행 시 |
| CHANGELOG.md | 버전별 변경 이력 | 기능 변경 시 |
| KNOWN_ISSUES.md | 알려진 이슈 추적 | 이슈 발견 시 |

### 기억 이전 체계
- **즉시** (같은 날): SESSION_HANDOFF.md → 다음 세션이 읽음
- **공통 인덱스**: SESSION_CONTEXT_INDEX.md → 세션 시작 시 반드시 읽음
- **문서 체계**: DOCUMENTATION_SYSTEM.md → 문서 역할과 업데이트 기준 고정
- **단기** (1주): work-history.md, KNOWN_ISSUES.md, DEV_LOG.md, DEV_VLOG.md
- **장기** (영구): dev-journal.md, CHANGELOG.md, PLATFORM_IMPLEMENTATION_TRACKER.md, CLAUDE.md
- **전략 기억**: claude.ai (전략 담당)가 메모리로 장기 기억 유지
