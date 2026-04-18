defmodule Darwin.V2.LLM.HubClient do
  @moduledoc "다윈 Hub HTTP 클라이언트 — 공용 레이어 위임."
  use Jay.Core.LLM.HubClient,
    team:        "darwin",
    routing_env: "LLM_HUB_ROUTING_ENABLED",
    shadow_env:  "LLM_HUB_ROUTING_SHADOW"
end
