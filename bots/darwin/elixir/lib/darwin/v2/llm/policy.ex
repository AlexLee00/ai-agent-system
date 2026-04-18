defmodule Darwin.V2.LLM.Policy do
  @moduledoc """
  다윈 팀 LLM 정책 — Jay.Core.LLM.Policy Behaviour 구현.
  Kill switch는 Darwin.V2.Config.kill_switch?() 위임.
  """

  @behaviour Jay.Core.LLM.Policy

  @agent_policies %{
    "darwin.scanner"               => %{route: :anthropic_haiku,  fallback: [:anthropic_sonnet]},
    "darwin.evaluator"             => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "darwin.planner"               => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "darwin.edison"                => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "darwin.verifier"              => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "darwin.commander"             => %{route: :anthropic_opus,   fallback: [:anthropic_sonnet]},
    "darwin.reflexion"             => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "darwin.espl"                  => %{route: :anthropic_haiku,  fallback: [:anthropic_sonnet]},
    "darwin.self_rag"              => %{route: :anthropic_haiku,  fallback: []},
    "darwin.self_rewarding_judge"  => %{route: :anthropic_haiku,  fallback: [:anthropic_sonnet]},
    "darwin.rag.query_planner"     => %{route: :anthropic_haiku,  fallback: []},
    "darwin.rag.synthesizer"       => %{route: :anthropic_haiku,  fallback: [:anthropic_sonnet]},
    "commander"                    => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "evaluator"                    => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "planner"                      => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "implementor"                  => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "verifier"                     => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "applier"                      => %{route: :anthropic_haiku,  fallback: []},
    "learner"                      => %{route: :anthropic_haiku,  fallback: []},
    "scanner"                      => %{route: :anthropic_haiku,  fallback: []},
    "reflexion"                    => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "self_rag.retrieve"            => %{route: :anthropic_haiku,  fallback: []},
    "self_rag.relevance"           => %{route: :anthropic_haiku,  fallback: []},
    "espl.crossover"               => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "espl.mutation"                => %{route: :anthropic_haiku,  fallback: []},
    "principle.critique"           => %{route: :anthropic_opus,   fallback: [:anthropic_sonnet]},
  }

  @agent_affinity %{
    "darwin.evaluator"   => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.6},
    "darwin.planner"     => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.5},
    "darwin.commander"   => %{anthropic_opus: 1.0, anthropic_sonnet: 0.8},
    "darwin.reflexion"   => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.6},
    "darwin.espl"        => %{anthropic_haiku: 1.0, anthropic_sonnet: 0.7},
    "darwin.scanner"     => %{anthropic_haiku: 1.0, anthropic_sonnet: 0.5},
    "espl.crossover"     => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.5},
    "espl.mutation"      => %{anthropic_haiku: 1.0, anthropic_sonnet: 0.6},
    "principle.critique" => %{anthropic_opus: 1.0, anthropic_sonnet: 0.8},
  }

  @impl true
  def agent_policies, do: @agent_policies

  @impl true
  def default_policy, do: %{route: :anthropic_haiku, fallback: []}

  @impl true
  def agent_affinity, do: @agent_affinity

  @impl true
  def daily_budget_usd do
    case Float.parse(System.get_env("DARWIN_LLM_DAILY_BUDGET_USD", "15.0")) do
      {f, _} -> f
      :error  -> 15.0
    end
  end

  @impl true
  def routing_log_table, do: "darwin_v2_llm_routing_log"

  @impl true
  def cost_tracking_table, do: "darwin_llm_cost_tracking"

  @impl true
  def team_name, do: "darwin"

  @impl true
  def log_prefix, do: "[다윈V2 LLM]"

  @impl true
  def api_key, do: Darwin.V2.Config.anthropic_api_key()

  @impl true
  def hub_routing_enabled?, do: System.get_env("LLM_HUB_ROUTING_ENABLED") == "true"

  @impl true
  def hub_shadow?, do: System.get_env("LLM_HUB_ROUTING_SHADOW") == "true"

  @impl true
  def kill_switch?, do: Darwin.V2.Config.kill_switch?()
end
