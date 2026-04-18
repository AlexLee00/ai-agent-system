defmodule Jay.Core.LLM.Policy do
  @moduledoc """
  팀별 LLM 정책 주입을 위한 Behaviour.

  각 팀은 이 Behaviour를 구현하고 필수 콜백을 제공한다.
  Jay.Core.LLM.Selector가 이 콜백을 통해 팀별 정책을 주입받는다.
  """

  @doc "에이전트별 정적 라우팅 정책 맵 (agent_name → %{route:, fallback:})"
  @callback agent_policies() :: %{String.t() => map()}

  @doc "기본 정책 (미등록 에이전트용)"
  @callback default_policy() :: map()

  @doc "에이전트별 모델 적합도 맵 (Recommender용)"
  @callback agent_affinity() :: %{String.t() => map()}

  @doc "일일 예산 한도 (USD)"
  @callback daily_budget_usd() :: float()

  @doc "라우팅 로그 DB 테이블 이름"
  @callback routing_log_table() :: String.t()

  @doc "비용 추적 DB 테이블 이름"
  @callback cost_tracking_table() :: String.t()

  @doc "팀 식별자 (Hub callerTeam 필드)"
  @callback team_name() :: String.t()

  @doc "로그 접두사 (예: \"[sigma/llm]\")"
  @callback log_prefix() :: String.t()

  @doc "Anthropic API 키 반환"
  @callback api_key() :: String.t() | nil

  @doc "Hub 라우팅 활성화 여부"
  @callback hub_routing_enabled?() :: boolean()

  @doc "Hub Shadow Mode 활성화 여부"
  @callback hub_shadow?() :: boolean()

  @doc "Kill switch 활성화 여부 (팀 선택적 구현)"
  @callback kill_switch?() :: boolean()

  @optional_callbacks [kill_switch?: 0]
end
