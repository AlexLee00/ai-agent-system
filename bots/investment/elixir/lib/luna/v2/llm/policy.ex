defmodule Luna.V2.LLM.Policy do
  @moduledoc """
  루나 팀 LLM 정책 — Jay.Core.LLM.Policy Behaviour 구현.
  Hub 라우팅 환경변수는 LUNA_ 접두사 사용.
  """

  @behaviour Jay.Core.LLM.Policy

  @agent_policies %{
    "luna.commander"             => %{route: :anthropic_haiku,  fallback: [:anthropic_sonnet]},
    "luna.decision_rationale"    => %{route: :anthropic_haiku,  fallback: [:anthropic_sonnet]},
    "luna.rag.query_planner"     => %{route: :anthropic_haiku,  fallback: []},
    "luna.rag_query_planner"     => %{route: :anthropic_haiku,  fallback: []},
    "luna.rag.multi_source"      => %{route: :anthropic_haiku,  fallback: []},
    "luna.rag.quality_evaluator" => %{route: :anthropic_haiku,  fallback: [:anthropic_sonnet]},
    "luna.rag.response_synth"    => %{route: :anthropic_haiku,  fallback: [:anthropic_sonnet]},
    "luna.self_rewarding_judge"  => %{route: :anthropic_haiku,  fallback: [:anthropic_sonnet]},
    "luna.reflexion"             => %{route: :anthropic_haiku,  fallback: [:anthropic_sonnet]},
    "luna.espl"                  => %{route: :anthropic_haiku,  fallback: [:anthropic_sonnet]},
    "luna.principle.critique"    => %{route: :anthropic_opus,   fallback: [:anthropic_sonnet]},
    "luna.mapek.analyzer"        => %{route: :anthropic_haiku,  fallback: [:anthropic_sonnet]},
    "luna.strategy.validator"    => %{route: :anthropic_haiku,  fallback: [:anthropic_sonnet]},
  }

  @agent_affinity %{
    "luna.commander"              => %{anthropic_haiku: 1.0, anthropic_sonnet: 0.7, anthropic_opus: 0.3},
    "luna.decision_rationale"     => %{anthropic_haiku: 1.0, anthropic_sonnet: 0.8},
    "luna.rag.query_planner"      => %{anthropic_haiku: 1.0},
    "luna.self_rewarding_judge"   => %{anthropic_haiku: 1.0, anthropic_sonnet: 0.7},
    "luna.reflexion"              => %{anthropic_haiku: 1.0, anthropic_sonnet: 0.7},
    "luna.espl"                   => %{anthropic_haiku: 1.0, anthropic_sonnet: 0.7},
    "luna.principle.critique"     => %{anthropic_opus: 1.0, anthropic_sonnet: 0.8},
    "luna.mapek.analyzer"         => %{anthropic_haiku: 1.0, anthropic_sonnet: 0.7},
    "luna.strategy.validator"     => %{anthropic_haiku: 1.0, anthropic_sonnet: 0.8},
  }

  @impl true
  def agent_policies, do: @agent_policies

  @impl true
  def default_policy, do: %{route: :anthropic_haiku, fallback: []}

  @impl true
  def agent_affinity, do: @agent_affinity

  @impl true
  def daily_budget_usd do
    case Float.parse(System.get_env("LUNA_LLM_DAILY_BUDGET_USD", "30.0")) do
      {f, _} -> f
      :error  -> 30.0
    end
  end

  @impl true
  def routing_log_table, do: "luna_llm_routing_log"

  @impl true
  def cost_tracking_table, do: "luna_llm_cost_tracking"

  @impl true
  def team_name, do: "luna"

  @impl true
  def log_prefix, do: "[루나V2 LLM]"

  @impl true
  def api_key do
    if anthropic_public_api_enabled?() do
      System.get_env("ANTHROPIC_API_KEY")
    end
  end

  defp anthropic_public_api_enabled? do
    Enum.any?(["HUB_ENABLE_CLAUDE_PUBLIC_API", "HUB_ENABLE_ANTHROPIC_PUBLIC_API"], fn key ->
      String.downcase(System.get_env(key, "")) in ["1", "true", "yes", "y", "on"]
    end)
  end

  @impl true
  def hub_routing_enabled?, do: System.get_env("LUNA_LLM_HUB_ROUTING_ENABLED") == "true"

  @impl true
  def hub_shadow?, do: System.get_env("LUNA_LLM_HUB_ROUTING_SHADOW") == "true"
end
