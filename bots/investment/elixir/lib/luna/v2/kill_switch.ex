defmodule Luna.V2.KillSwitch do
  @moduledoc """
  Luna V2 Kill Switch — 환경변수 기반 기능 제어.

  기본 ALL OFF 안전 모드.
  단계적으로 ON: Shadow → Commander → MAPE-K

  환경변수:
    LUNA_V2_ENABLED=true           → V2 수퍼바이저 전체 기동
    LUNA_COMMANDER_ENABLED=true    → Commander (Jido.AI.Agent) 활성
    LUNA_MAPEK_ENABLED=true        → MAPE-K 자율 루프 활성
    LUNA_LLM_HUB_ENABLED=true      → Hub LLM 라우팅 활성 (TS 레이어)
    LUNA_LLM_HUB_SHADOW=true       → Shadow 비교 모드
  """

  def v2_enabled?,        do: Application.get_env(:luna, :v2_enabled, false)
  def commander_enabled?, do: Application.get_env(:luna, :commander_enabled, false)
  def mapek_enabled?,     do: Application.get_env(:luna, :mapek_enabled, false)
  def shadow_mode?,       do: Application.get_env(:luna, :shadow_mode, false)
  def hub_routing?,       do: Application.get_env(:luna, :hub_routing, false)
end
