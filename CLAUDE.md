# 팀 제이 (Team Jay) 아키텍처

> 전략문서 상세: team-jay-strategy.md 참조
> 최종 업데이트: 2026-03-08

## 명칭 체계

| 구분 | 이름 | 설명 |
|------|------|------|
| 마스터 | Alex | 사람 (전략 설정, 예외 승인) |
| 시스템 | 팀 제이 | ai-agent-system 전체 |
| 메인봇 | 제이 (Jay) | 총괄 허브 |
| SKA팀장 | 스카 | 매출관리 + 예약관리 |
| 시스템팀장 | 클로드 | 시스템 개선·유지보수 |
| 투자팀장 | 루나 | 자동매매 (암호화폐 실투자, 국내외장 모의) |

## 3계층 에이전트 모델

```
Layer 3: 마스터 (Alex) — 전략 설정, 예외 승인
Layer 2: 팀장 봇 (LLM) — 스카/클로드/루나, 자율 판단·조율
Layer 1: 팀원 봇 (규칙) — 앤디/지미/덱스터/아리아 등, 실행·보고
```

## 팀별 LLM 모델

| 팀 | 팀장 모델 | 특징 |
|----|----------|------|
| 스카팀 | Groq 무료 | 예외 상황에서만 LLM (일 5-10회) |
| 클로드팀 | Claude Sonnet | 기술 판단 (일 10-20회) |
| 루나팀 | Sonnet + Opus(제한) | 깊은 분석·토론 (일 20-50회) |

## 소통 구조

| 경로 | 기술 |
|------|------|
| 마스터 ↔ 팀장 | 텔레그램 Forum Topic |
| 팀장 ↔ 팀장 | OpenClaw sessions_send |
| 팀장 ↔ 팀원 | State Bus (agent_events / agent_tasks) |

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

## LLM 최적화 원칙

- 지능형 모델 라우팅: 복잡도별 자동 분배 (단순→Groq, 복잡→Sonnet, 깊은→Opus)
- 시맨틱 캐싱: SQLite 기반, 팀별 TTL 차등 (스카 30분, 클로드 6시간, 루나 5분)
- Anthropic Prompt Caching: 시스템 프롬프트 캐싱으로 비용 절감
- LLM 졸업: 반복 판단 패턴 → 규칙 전환 (로거가 추적, 마스터 승인 후 적용)
- 모든 LLM 호출은 로거(Logger)를 경유하여 비용 추적

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

---

## 개발 루틴 (대규모/핵심 개발 시 필수)

### 세션 시작 루틴
1. CLAUDE.md 읽기 (프로젝트 규칙)
2. docs/SESSION_HANDOFF.md 읽기 (이전 세션 컨텍스트)
3. docs/KNOWN_ISSUES.md 확인 (현재 알려진 문제)
4. team-jay-strategy.md 해당 섹션 확인 (오늘 할 일)
5. git status로 현재 상태 확인

### 세션 마무리 루틴
1. Git 커밋 (미커밋 변경사항 정리)
2. docs/work-history.md 업데이트 (오늘 한 일 — 사실 중심)
3. docs/dev-journal.md 업데이트 (중요 결정/인사이트 — 연구/논문/발표용)
4. docs/TEST_RESULTS.md 업데이트 (테스트 실행했다면)
5. docs/CHANGELOG.md 업데이트 (기능 추가/변경이 있었다면)
6. docs/KNOWN_ISSUES.md 업데이트 (새로 발견된 이슈가 있다면)
7. docs/SESSION_HANDOFF.md 작성 (다음 세션에 전달할 컨텍스트)
8. Git 최종 커밋 + push — 커밋 메시지: `docs: 세션 마감 문서 업데이트 (YYYY-MM-DD)`

### 작업 중 규칙
- 의미 있는 단위로 자주 Git 커밋 (한 번에 몰아서 ❌)
- 커밋 메시지: `feat:`, `fix:`, `docs:`, `chore:` 접두사 + 한국어
- 새로운 기능/변경 시 해당 테스트 작성 또는 실행

### 개발 문서 목적

| 문서 | 목적 | 작성 시점 |
|------|------|----------|
| work-history.md | 무엇을 했는가 (사실, 변경 파일, 테스트 결과) | 매 작업 완료 즉시 |
| dev-journal.md | 왜 이렇게 결정했는가 (연구/논문/발표용) | 중요 결정/인사이트 시 |
| SESSION_HANDOFF.md | 다음 세션에 전달할 맥락 (기억 이전) | 매 세션 종료 시 |
| TEST_RESULTS.md | 테스트 결과 누적 | 테스트 실행 시 |
| CHANGELOG.md | 버전별 변경 이력 | 기능 변경 시 |
| KNOWN_ISSUES.md | 알려진 이슈 추적 | 이슈 발견 시 |

### 기억 이전 체계
- **즉시** (같은 날): SESSION_HANDOFF.md → 다음 세션이 읽음
- **단기** (1주): work-history.md, KNOWN_ISSUES.md
- **장기** (영구): dev-journal.md, CHANGELOG.md, team-jay-strategy.md, CLAUDE.md
- **전략 기억**: claude.ai (전략 담당)가 메모리로 장기 기억 유지
