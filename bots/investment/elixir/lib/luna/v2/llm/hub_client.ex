defmodule Luna.V2.LLM.HubClient do
  @moduledoc "루나 Hub HTTP 클라이언트 — 공용 레이어 위임."
  use Jay.Core.LLM.HubClient,
    team:        "luna",
    routing_env: "LUNA_LLM_HUB_ROUTING_ENABLED",
    shadow_env:  "LUNA_LLM_HUB_ROUTING_SHADOW"
end
