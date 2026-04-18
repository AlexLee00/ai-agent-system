defmodule Luna.V2.LLM.Selector do
  @moduledoc """
  루나 V2 LLM Selector — 공용 레이어 위임.

  Jay.Core.LLM.Selector를 사용하며 Luna.V2.LLM.Policy로 팀 정책 주입.

  라우팅 전략:
    Primary:  Hub /hub/llm/call → Claude Code OAuth → Groq 폴백
    Fallback: Anthropic API 직접 호출 (Hub 장애 시)

  환경변수:
    LUNA_LLM_HUB_ROUTING_ENABLED=true  → Hub 경유 활성화 (기본 false)
    LUNA_LLM_HUB_ROUTING_SHADOW=true   → Shadow Mode
    LUNA_LLM_DAILY_BUDGET_USD          → 일일 예산 (기본 $30)

  공개 API:
    complete/3           — (agent_name, messages, opts) → {:ok, content} | {:error, reason}
    call_with_fallback/3 — 구버전 호환 래퍼 (binary prompt)
    policy_for/1         — 에이전트 정적 정책 조회
  """

  use Jay.Core.LLM.Selector, policy_module: Luna.V2.LLM.Policy
end
