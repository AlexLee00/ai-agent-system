defmodule Darwin.V2.LLM.CostTracker do
  @moduledoc "다윈 LLM 비용 추적 — 공용 레이어 위임."
  use Jay.Core.LLM.CostTracker,
    table:          "darwin_llm_cost_tracking",
    budget_env:     "DARWIN_LLM_DAILY_BUDGET_USD",
    log_prefix:     "[다윈V2/cost]",
    default_budget: 15.0
end
