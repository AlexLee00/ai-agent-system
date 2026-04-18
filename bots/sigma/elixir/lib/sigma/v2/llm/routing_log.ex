defmodule Sigma.V2.LLM.RoutingLog do
  @moduledoc "시그마 LLM 라우팅 기록 — 공용 레이어 위임."
  use Jay.Core.LLM.RoutingLog,
    table:      "sigma_v2_llm_routing_log",
    log_prefix: "[sigma/routing_log]"
end
