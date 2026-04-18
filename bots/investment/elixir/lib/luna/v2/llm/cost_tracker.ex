defmodule Luna.V2.LLM.CostTracker do
  @moduledoc "루나 LLM 비용 추적 — 공용 레이어 위임."
  use Jay.Core.LLM.CostTracker,
    table:          "luna_llm_cost_tracking",
    budget_env:     "LUNA_LLM_DAILY_BUDGET_USD",
    log_prefix:     "[루나V2/cost]",
    default_budget: 30.0
end
