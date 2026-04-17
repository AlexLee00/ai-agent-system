defmodule Sigma.V2.LLM.Selector do
  @moduledoc """
  시그마 LLM 모델 선택자 — Anthropic API 직접 호출 + 정책 기반 fallback chain.

  Claude 전용 (로컬 LLM 제외 — 마스터 결정 2026-04-18).
  에이전트 이름 → provider/model 매핑 + fallback chain.
  비용 추적: Sigma.V2.LLM.CostTracker 사용.
  """

  require Logger

  @anthropic_api_url "https://api.anthropic.com/v1/messages"
  @anthropic_version "2023-06-01"

  @default_timeouts %{
    anthropic_haiku:  15_000,
    anthropic_sonnet: 30_000,
    anthropic_opus:   60_000,
  }

  # 에이전트별 LLM 정책 (Claude 전용 — packages/core/lib/llm-model-selector.ts sigma.agent_policy 동기화)
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
  }

  @default_policy %{route: :anthropic_haiku, fallback: []}

  @doc """
  에이전트 이름에 대한 LLM 정책 반환.
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

  defp do_call(agent_name, %{route: primary, fallback: fallback_routes}, prompt, opts) do
    try_routes(agent_name, [primary | fallback_routes], prompt, opts)
  end

  defp try_routes(agent_name, [], _prompt, _opts) do
    Logger.error("[sigma/llm] 모든 route 실패 — agent=#{agent_name}")
    {:error, :all_routes_failed}
  end

  defp try_routes(agent_name, [route | remaining], prompt, opts) do
    timeout = Map.get(@default_timeouts, route, 30_000)
    {_provider, model} = provider_from_route(route)
    max_tokens = Keyword.get(opts, :max_tokens, 1024)
    system = Keyword.get(opts, :system)

    case call_anthropic(model, prompt, system, max_tokens, timeout) do
      {:ok, text, usage} ->
        Sigma.V2.LLM.CostTracker.track_tokens(%{
          agent: to_string(agent_name),
          model: model,
          provider: "anthropic",
          tokens_in: usage.input_tokens,
          tokens_out: usage.output_tokens,
        })
        {:ok, %{response: text, model: model, tokens: %{in: usage.input_tokens, out: usage.output_tokens}}}

      {:error, reason} ->
        Logger.warning("[sigma/llm] #{model} 실패 (#{inspect(reason)}) — agent=#{agent_name}, 다음 폴백 시도")
        try_routes(agent_name, remaining, prompt, opts)
    end
  end

  defp call_anthropic(model, prompt, system, max_tokens, timeout) do
    key = api_key()

    if is_nil(key) or key == "" do
      {:error, :no_api_key}
    else
      messages = [%{role: "user", content: prompt}]
      body = %{model: model, max_tokens: max_tokens, messages: messages}
      body = if system, do: Map.put(body, :system, system), else: body

      case Req.post(@anthropic_api_url,
        json: body,
        headers: [
          {"x-api-key", key},
          {"anthropic-version", @anthropic_version}
        ],
        receive_timeout: timeout
      ) do
        {:ok, %{status: 200, body: %{"content" => [%{"text" => text} | _], "usage" => usage}}} ->
          {:ok, text,
           %{
             input_tokens: Map.get(usage, "input_tokens", 0),
             output_tokens: Map.get(usage, "output_tokens", 0)
           }}

        {:ok, %{status: status, body: body}} ->
          {:error, {:http_error, status, body}}

        {:error, reason} ->
          {:error, reason}
      end
    end
  end

  defp api_key do
    System.get_env("ANTHROPIC_API_KEY") ||
      System.get_env("SIGMA_ANTHROPIC_API_KEY")
  end

  defp provider_from_route(:anthropic_haiku),  do: {:anthropic, "claude-haiku-4-5-20251001"}
  defp provider_from_route(:anthropic_sonnet), do: {:anthropic, "claude-sonnet-4-6"}
  defp provider_from_route(:anthropic_opus),   do: {:anthropic, "claude-opus-4-7"}
  defp provider_from_route(_),                 do: {:anthropic, "claude-haiku-4-5-20251001"}
end
