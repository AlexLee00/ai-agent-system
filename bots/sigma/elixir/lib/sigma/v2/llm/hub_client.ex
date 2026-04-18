defmodule Sigma.V2.LLM.HubClient do
  @moduledoc "시그마 Hub HTTP 클라이언트 — 공용 레이어 위임."
  use Jay.Core.LLM.HubClient,
    team:        "sigma",
    routing_env: "LLM_HUB_ROUTING_ENABLED",
    shadow_env:  "LLM_HUB_ROUTING_SHADOW"
end
