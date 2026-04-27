defmodule Sigma.V2.LLM.Policy do
  @moduledoc """
  시그마 팀 LLM 정책 — Jay.Core.LLM.Policy Behaviour 구현.
  팀별 에이전트 정책, 예산, 라우팅 환경변수를 정의.
  """

  @behaviour Jay.Core.LLM.Policy

  @agent_policies %{
    "commander"               => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "pod.risk"                => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "pod.growth"              => %{route: :anthropic_haiku,  fallback: []},
    "pod.trend"               => %{route: :anthropic_haiku,  fallback: []},
    "skill.data_quality"      => %{route: :anthropic_haiku,  fallback: []},
    "skill.causal"            => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "skill.experiment_design" => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "skill.feature_planner"   => %{route: :anthropic_haiku,  fallback: []},
    "skill.observability"     => %{route: :anthropic_haiku,  fallback: []},
    "principle.self_critique" => %{route: :anthropic_opus,   fallback: [:anthropic_sonnet]},
    "reflexion"               => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "espl"                    => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "self_rewarding_judge"    => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "mapek.monitor"           => %{route: :anthropic_haiku,  fallback: []},
    "rag.query_planner"       => %{route: :anthropic_haiku,  fallback: []},
    "rag.retriever"           => %{route: :anthropic_haiku,  fallback: []},
    "rag.quality_evaluator"   => %{route: :anthropic_haiku,  fallback: []},
    "rag.synthesizer"         => %{route: :anthropic_haiku,  fallback: []},
  }

  @agent_affinity %{
    "reflexion"              => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.6, anthropic_opus: 0.3},
    "espl.crossover"         => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.5},
    "espl.mutation"          => %{anthropic_haiku: 1.0, anthropic_sonnet: 0.7},
    "self_rag.retrieve_gate" => %{anthropic_haiku: 1.0},
    "self_rag.relevance"     => %{anthropic_haiku: 1.0},
    "principle.critique"     => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.7},
  }

  @impl true
  def agent_policies, do: @agent_policies

  @impl true
  def default_policy, do: %{route: :anthropic_haiku, fallback: []}

  @impl true
  def agent_affinity, do: @agent_affinity

  @impl true
  def daily_budget_usd do
    case Float.parse(System.get_env("SIGMA_LLM_DAILY_BUDGET_USD", "10.0")) do
      {f, _} -> f
      :error  -> 10.0
    end
  end

  @impl true
  def routing_log_table, do: "sigma_v2_llm_routing_log"

  @impl true
  def cost_tracking_table, do: "sigma_llm_cost_tracking"

  @impl true
  def team_name, do: "sigma"

  @impl true
  def log_prefix, do: "[sigma/llm]"

  @impl true
  def api_key do
    if anthropic_public_api_enabled?() do
      System.get_env("ANTHROPIC_API_KEY") ||
        System.get_env("SIGMA_ANTHROPIC_API_KEY") ||
        load_from_secrets()
    end
  end

  defp anthropic_public_api_enabled? do
    Enum.any?(["HUB_ENABLE_CLAUDE_PUBLIC_API", "HUB_ENABLE_ANTHROPIC_PUBLIC_API"], fn key ->
      String.downcase(System.get_env(key, "")) in ["1", "true", "yes", "y", "on"]
    end)
  end

  @impl true
  def hub_routing_enabled?, do: System.get_env("LLM_HUB_ROUTING_ENABLED") == "true"

  @impl true
  def hub_shadow?, do: System.get_env("LLM_HUB_ROUTING_SHADOW") == "true"

  defp load_from_secrets do
    candidates = [
      System.get_env("SIGMA_SECRETS_PATH"),
      Path.expand("../../../../../secrets.json", __DIR__),
      Path.join(File.cwd!(), "bots/sigma/secrets.json")
    ]

    Enum.find_value(candidates, fn path ->
      with path when is_binary(path) <- path,
           true <- File.exists?(path),
           {:ok, body} <- File.read(path),
           {:ok, decoded} <- Jason.decode(body),
           key when is_binary(key) and key != "" <- Map.get(decoded, "anthropic_api_key") do
        key
      else
        _ -> nil
      end
    end)
  end
end
