# Darwin V2 — Kill Switch 및 환경변수 제어

> 최종 업데이트: 2026-04-18

---

## 개요

Darwin V2의 모든 기능은 환경변수로 제어됩니다. 기본값은 **안전 우선(conservative)**으로 설정되어 있으며, 기능 활성화는 명시적으로 이루어져야 합니다.

---

## 환경변수 목록

### 마스터 스위치

| 변수명 | 기본값 | 설명 |
|--------|--------|------|
| `DARWIN_V2_ENABLED` | `false` | Darwin V2 전체 마스터 스위치. `false`이면 V1만 실행 |
| `DARWIN_KILL_SWITCH` | `true` | 긴급 중단 스위치. `true`이면 모든 파이프라인 차단 |

> **주의**: `DARWIN_KILL_SWITCH=true`는 "차단됨"을 의미합니다. 운영을 재개하려면 `false`로 설정해야 합니다.

---

### 파이프라인 기능 스위치

| 변수명 | 기본값 | 설명 |
|--------|--------|------|
| `DARWIN_SHADOW_MODE` | `true` | V2를 V1과 병렬로 섀도우 실행. 결과를 비교하되 실제 적용하지 않음 |
| `DARWIN_SELF_RAG_ENABLED` | `false` | 4-gate Self-RAG 논문 분류 활성화 |
| `DARWIN_ESPL_ENABLED` | `false` | 주간 프롬프트 진화(ESPL) 활성화 |
| `DARWIN_TIER2_AUTO_APPLY` | `false` | Tier 2(설정 변경) 자동 적용. `true`이면 L5에서만 동작 |
| `DARWIN_MCP_SERVER_ENABLED` | `false` | Darwin MCP 툴 서버 활성화 |

---

### 센서 스위치

| 변수명 | 기본값 | 설명 |
|--------|--------|------|
| `DARWIN_SENSOR_ARXIV_ENABLED` | `true` | arXiv RSS 논문 스캐너 활성화 |
| `DARWIN_SENSOR_SEMANTIC_ENABLED` | `false` | Semantic Scholar API 스캐너 활성화 |
| `DARWIN_SENSOR_GITHUB_ENABLED` | `false` | GitHub Trending 스캐너 활성화 |

---

### 원칙 검사 스위치

| 변수명 | 기본값 | 설명 |
|--------|--------|------|
| `DARWIN_PRINCIPLE_SEMANTIC_CHECK` | `false` | LLM 기반 원칙 위반 의미론적 검사. `true`이면 Haiku 호출 |
| `DARWIN_PRINCIPLE_BLOCK_ON_WARN` | `true` | 원칙 경고(Tier 2) 시 파이프라인 중단 여부 |

---

### 비용 제어

| 변수명 | 기본값 | 설명 |
|--------|--------|------|
| `DARWIN_LLM_DAILY_BUDGET_USD` | `10` | 일일 LLM 비용 상한 (USD). 초과 시 당일 파이프라인 중단 |
| `DARWIN_LLM_PER_PAPER_BUDGET_USD` | `5` | 논문당 최대 LLM 비용 (Tier 3 원칙). 초과 시 즉시 중단 |

---

## Kill Switch 사용 시나리오

### 긴급 중단 (즉시)

```bash
# OPS 서버에서 직접 설정
export DARWIN_KILL_SWITCH=true

# 또는 secrets-store.json에 반영 후 Hub 재시작
```

활성화 즉시:
1. 진행 중인 파이프라인: 현재 단계 완료 후 중단
2. 새 파이프라인: 시작 불가
3. JayBus에 `kill_switch_activated` 이벤트 발행
4. 마스터에게 Slack/알림 발송

### 운영 재개

```bash
# 마스터 명시 승인 후
export DARWIN_KILL_SWITCH=false
export DARWIN_V2_ENABLED=true
```

---

## 권장 초기 설정 (단계적 활성화)

### 1단계: 섀도우 관찰

```bash
DARWIN_V2_ENABLED=true
DARWIN_KILL_SWITCH=false
DARWIN_SHADOW_MODE=true
DARWIN_TIER2_AUTO_APPLY=false
DARWIN_ESPL_ENABLED=false
DARWIN_SELF_RAG_ENABLED=false
```

### 2단계: 완전 자율 (L5 승격 후)

```bash
DARWIN_V2_ENABLED=true
DARWIN_KILL_SWITCH=false
DARWIN_SHADOW_MODE=false
DARWIN_TIER2_AUTO_APPLY=true
DARWIN_ESPL_ENABLED=true
DARWIN_SELF_RAG_ENABLED=true
```

---

## 환경변수 로딩 우선순위

1. 프로세스 환경변수 (`process.env`)
2. `bots/darwin/config.yaml` (런타임 설정)
3. Hub `secrets-store.json` (비밀값 제외 설정)
4. 코드 기본값 (conservative)
