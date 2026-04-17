defmodule Sigma.V2.LLM.Selector do
  @moduledoc """
  시그마 LLM 모델 선택자 — req_llm 위에 정책 추상화.

  루나 패턴 참고:
    - bots/investment/shared/llm-client.ts
    - packages/core/lib/llm-model-selector.ts

  에이전트 이름 → provider/model 매핑 + fallback chain.
  비용 추적: Sigma.V2.LLM.CostTracker 사용.
  """

  require Logger

  @default_timeouts %{
    anthropic_haiku:  15_000,
    anthropic_sonnet: 30_000,
    anthropic_opus:   60_000,
    ollama_8b:        30_000,
    ollama_32b:       120_000
  }

  # 에이전트별 LLM 정책 (packages/core/lib/llm-model-selector.ts의 sigma.agent_policy 동기화)
  @agent_policies %{
    "commander"                => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku, :ollama_32b]},
    "pod.risk"                 => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku, :ollama_32b]},
    "pod.growth"               => %{route: :anthropic_haiku,  fallback: [:ollama_8b]},
    "pod.trend"                => %{route: :anthropic_haiku,  fallback: [:ollama_8b]},
    "skill.data_quality"       => %{route: :ollama_8b,        fallback: [:anthropic_haiku]},
    "skill.causal"             => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "skill.experiment_design"  => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "skill.feature_planner"    => %{route: :anthropic_haiku,  fallback: [:ollama_8b]},
    "skill.observability"      => %{route: :anthropic_haiku,  fallback: [:ollama_8b]},
    "principle.self_critique"  => %{route: :anthropic_opus,   fallback: [:anthropic_sonnet]},
    "reflexion"                => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "espl"                     => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
  }

  @default_policy %{route: :anthropic_haiku, fallback: [:ollama_8b]}

  @doc """
  에이전트 이름에 대한 LLM 정책 반환.

  ## Examples

      iex> Sigma.V2.LLM.Selector.policy_for(:commander)
      %{route: :anthropic_sonnet, fallback: [:anthropic_haiku, :ollama_32b]}
  """
  def policy_for(agent_name) do
    Map.get(@agent_policies, to_string(agent_name), @default_policy)
  end

  @doc """
  agent_name + prompt → LLM 호출 (fallback 포함).
  """
  def call_with_fallback(agent_name, prompt, opts \\ []) do
    case Sigma.V2.LLM.CostTracker.check_budget() do
      {:ok, _} ->
        do_call(agent_name, policy_for(agent_name), prompt, opts)

      {:error, :budget_exceeded} ->
        Logger.error("[sigma/llm] 일일 예산 초과 — agent=#{agent_name}")
        {:error, :budget_exceeded}
    end
  end

  defp do_call(agent_name, %{route: route, fallback: fallback_routes}, _prompt, _opts) do
    _timeout = @default_timeouts[route] || 30_000
    {provider, model} = provider_from_route(route)

    # Phase 2에서 req_llm 실제 통합 예정
    # result = ReqLLM.generate_text(provider, model: model, prompt: prompt, timeout: _timeout)
    resp = %{response: "TODO: req_llm Phase 2", model: model, tokens: %{in: 0, out: 0}}

    Sigma.V2.LLM.CostTracker.track_tokens(%{
      agent: to_string(agent_name),
      model: model,
      provider: to_string(provider),
      tokens_in: get_in(resp, [:tokens, :in]) || 0,
      tokens_out: get_in(resp, [:tokens, :out]) || 0,
    })

    _ = fallback_routes  # Phase 2에서 실제 fallback 구현
    {:ok, resp}
  end

  defp provider_from_route(:anthropic_haiku),  do: {:anthropic, "claude-haiku-4-5-20251001"}
  defp provider_from_route(:anthropic_sonnet), do: {:anthropic, "claude-sonnet-4-6"}
  defp provider_from_route(:anthropic_opus),   do: {:anthropic, "claude-opus-4-7"}
  defp provider_from_route(:ollama_8b),        do: {:ollama, "qwen2.5-7b"}
  defp provider_from_route(:ollama_32b),       do: {:ollama, "deepseek-r1-32b"}
  defp provider_from_route(_),                 do: {:anthropic, "claude-haiku-4-5-20251001"}
end
