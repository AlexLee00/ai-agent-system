# 클로드팀 CLAUDE_NOTES

## 팀 구성원

| ID | 이름 | 역할 |
|----|------|------|
| claude | 클로드 | 메인봇 — 전체 설계·개발·유지보수 |
| dexter | 덱스터 | 시스템 점검봇 — 주기 실행 (launchd, 1시간) |
| eric | 에릭 | Claude Code Explore 에이전트 |
| kevin | 케빈 | Claude Code Plan 에이전트 |
| brian | 브라이언 | Claude Code Bash 에이전트 |

---

## 절대규칙 (클로드팀)

1. **DEV 모드에서 개발·테스트 → 사용자 협의 후 OPS 배포**
2. **클로드팀 메인봇 이름은 반드시 클로드 — 변경 불가**
3. **절대규칙은 사용자 지시로만 등록·수정·삭제 가능**

---

## 덱스터 행동 지침

### 실행 모드
| 플래그 | 동작 |
|--------|------|
| (기본) | 8개 섹션 점검 + 콘솔 출력 |
| --full | npm audit 포함 전체 점검 |
| --telegram | 이상 발견 시 텔레그램 발송 |
| --fix | 자동 수정 가능 항목 처리 |
| --report-only | 무음 (로그 기록만) |

### 자동 수정 허용 항목
- stale lock 파일 (프로세스 종료 확인 후 삭제)
- secrets.json 권한 → chmod 600
- 로그 파일 크기 초과 → 백업 후 비움

### 버그 레포트 등록 (코드 수정 없이 처리 불가)
- DB 무결성 오류
- 핵심 파일 체크섬 변경 (소스 파일 변경 감지)
- 하드코딩 API 키 발견
- npm 취약점 (critical/high)
- 봇 반복 오류 패턴

### 일일 보고 (--daily-report)
- 당일 점검 이력 집계 (덱스터 로그 파싱)
- 루나팀: 오늘 거래 수, 포지션, 신호 BUY/SELL/HOLD
- 스카팀: 오늘 예약 총수, 확정, 취소
- `--telegram` 함께 사용 시 텔레그램 발송
- launchd `ai.claude.dexter.daily` → 매일 08:00 KST 자동 발송

### 체크섬 업데이트 (--update-checksums)
- 새 봇 추가 / 의도적 코드 수정 후 체크섬 갱신
- `node src/dexter.js --update-checksums` 실행 시 `.checksums.json` 재생성
- 반드시 사용자 승인 후 실행할 것

### 주기 실행 (launchd)
| 서비스 | 주기 | 플래그 | 로그 |
|--------|------|--------|------|
| `ai.claude.dexter` | 매 1시간 | `--telegram --fix` | `dexter.log` |
| `ai.claude.dexter.daily` | 매일 08:00 KST | `--daily-report --telegram` | `dexter-daily.log` |

---

---

## 아처 행동 지침

### 실행 모드
| 플래그 | 동작 |
|--------|------|
| (기본) | 데이터 수집 → Claude 분석 → 마크다운 리포트 저장 |
| --telegram | 요약을 텔레그램으로 발송 |
| --no-claude | Claude API 건너뜀 (데이터 수집 + 리포트만) |

### 수집 데이터
| 소스 | 내용 |
|------|------|
| GitHub Releases API | ccxt, duckdb, better-sqlite3, playwright, anthropic-sdk, groq-node, gemini-js 최신 버전 |
| npm Registry | 위 패키지 npm 최신 버전 |
| Binance 24hr ticker | BTC/USDT, ETH/USDT 가격·변동률 |
| Fear & Greed Index | 공포탐욕지수 (최근 7일) |

### 출력
- 마크다운 리포트: `bots/claude/reports/archer-YYYY-MM-DD.md`
- 캐시 (버전 diff 기준): `bots/claude/archer-cache.json`
- 로그: `/tmp/archer.log`

### 주기 실행 (launchd)
| 서비스 | 주기 | 플래그 | 로그 |
|--------|------|--------|------|
| `ai.claude.archer` | 매주 월요일 09:00 KST | `--telegram` | `archer.log` |

---

## 점검 섹션 목록

| 섹션 | 담당 파일 |
|------|-----------|
| 리소스 (CPU/메모리/디스크) | lib/checks/resources.js |
| 네트워크 연결 | lib/checks/network.js |
| 봇 프로세스 상태 | lib/checks/bots.js |
| 로그 오류 분석 | lib/checks/logs.js |
| 보안 점검 | lib/checks/security.js |
| DB 무결성 | lib/checks/database.js |
| 코드 무결성 (체크섬) | lib/checks/code.js |
| 의존성 보안 (npm audit) | lib/checks/deps.js |
