# Skill Registry 사용 가이드

## 스킬 실행

```elixir
alias TeamJay.Ska.SkillRegistry

# 기본 실행
{:ok, result} = SkillRegistry.execute(:detect_session_expiry, %{
  agent: :andy,
  response_html: html,
  status_code: 200
})

# 조회 (ETS 직접 — 빠름)
{:ok, skill} = SkillRegistry.fetch(:parse_naver_html)

# 목록
all_skills = SkillRegistry.list()
naver_skills = SkillRegistry.list(%{domain: :naver})
```

## 스킬 목록

### 공통 스킬 (모든 에이전트)

| 스킬명 | 입력 | 출력 |
|--------|------|------|
| `:detect_session_expiry` | `agent, response_html, status_code` | `{status: :healthy/:expired/:suspicious}` |
| `:notify_failure` | `agent, severity, message, metadata` | `{notified: bool, channels: list}` |
| `:persist_cycle_metrics` | `agent, success, duration_ms, items_processed` | `{persisted: bool}` |
| `:trigger_recovery` | `agent, failure_type, context` | `{recovery_triggered: bool, strategy: atom}` |
| `:audit_db_integrity` | `table, checks` | `{passed: bool, issues: list}` |

### 도메인 스킬

| 스킬명 | 전용 에이전트 | 설명 |
|--------|-------------|------|
| `:parse_naver_html` | Andy | 네이버 예약 HTML 파싱 + SelectorManager 통합 |
| `:classify_kiosk_state` | Jimmy | 키오스크 상태 분류 (offline/frozen/active/idle) |
| `:audit_pos_transactions` | Pickko | POS 트랜잭션 감사 (중복/누락/금액 불일치) |

### 분석 스킬

| 스킬명 | 설명 |
|--------|------|
| `:forecast_demand` | Python forecast.py 경유 Prophet 수요 예측 |
| `:analyze_revenue` | Python rebecca.py 경유 매출 분석 |
| `:detect_anomaly` | Z-score/IQR 이상치 감지 |
| `:generate_report` | 일/주/월 리포트 Markdown 생성 |

## 새 스킬 등록

```elixir
defmodule TeamJay.Ska.Skill.MyNewSkill do
  @behaviour TeamJay.Ska.Skill

  @impl true
  def metadata do
    %{name: :my_new_skill, domain: :custom, version: "1.0",
      description: "내 새 스킬", input_schema: %{}, output_schema: %{}}
  end

  @impl true
  def run(params, _context) do
    # 구현
    {:ok, %{result: "done"}}
  end
end

# SkillRegistry에 등록
SkillRegistry.register(:my_new_skill, TeamJay.Ska.Skill.MyNewSkill, %{domain: :custom})
```
