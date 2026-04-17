defmodule Sigma.V2.LLM.Selector do
  @moduledoc """
  시그마 LLM 게이트웨이 v2 — Anthropic API 직접 호출 + Recommender 통합.

  Claude 전용 (로컬 LLM 제외 — 마스터 결정 2026-04-18).
  Recommender가 컨텍스트 기반 동적 모델 추천, 정적 정책은 폴백.
  모든 라우팅 결과는 RoutingLog에 기록.
  """

  require Logger

  @anthropic_api_url "https://api.anthropic.com/v1/messages"
  @anthropic_version "2023-06-01"

  @default_timeouts %{
    anthropic_haiku:  15_000,
    anthropic_sonnet: 30_000,
    anthropic_opus:   60_000,
  }

  # 에이전트별 정적 정책 (Recommender 실패 시 폴백 — packages/core/lib/llm-model-selector.ts sigma.agent_policy 동기화)
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
  에이전트 이름에 대한 정적 LLM 정책 반환.
  """
  def policy_for(agent_name) do
    Map.get(@agent_policies, to_string(agent_name), @default_policy)
  end

  @doc """
  agent_name + prompt → LLM 호출 (Recommender + fallback 포함).
  """
  def call_with_fallback(agent_name, prompt, opts \\ []) do
    case Sigma.V2.LLM.CostTracker.check_budget() do
      {:ok, budget_ratio} ->
        context = build_context(agent_name, prompt, opts, budget_ratio)

        {primary, fallback} =
          case Sigma.V2.LLM.Recommender.recommend(agent_name, context) do
            {:ok, %{primary: p, fallback: f}} ->
              Logger.info("[sigma/llm] #{agent_name} → #{p} (#{context[:reason] || "Recommender"})")
              {p, f}

            _ ->
              policy = policy_for(agent_name)
              {policy.route, policy.fallback}
          end

        try_routes(agent_name, [primary | fallback], prompt, opts, context, primary)

      {:error, :budget_exceeded} ->
        Logger.error("[sigma/llm] 일일 예산 초과 — agent=#{agent_name}")
        {:error, :budget_exceeded}
    end
  end

  # -------------------------------------------------------------------
  # Private — route chain
  # -------------------------------------------------------------------

  defp try_routes(agent_name, [], _prompt, _opts, ctx, primary) do
    Logger.error("[sigma/llm] 모든 route 실패 — agent=#{agent_name}")
    log_routing(agent_name, primary, nil, nil, false, ctx, "all_routes_failed")
    {:error, :all_routes_failed}
  end

  defp try_routes(agent_name, [route | remaining], prompt, opts, ctx, primary) do
    timeout = Map.get(@default_timeouts, route, 30_000)
    {_provider, model} = provider_from_route(route)
    max_tokens = Keyword.get(opts, :max_tokens, 1024)
    system = Keyword.get(opts, :system)

    start_ms = System.monotonic_time(:millisecond)

    case call_anthropic(model, prompt, system, max_tokens, timeout) do
      {:ok, text, usage} ->
        latency_ms = System.monotonic_time(:millisecond) - start_ms

        Sigma.V2.LLM.CostTracker.track_tokens(%{
          agent: to_string(agent_name),
          model: model,
          provider: "anthropic",
          tokens_in: usage.input_tokens,
          tokens_out: usage.output_tokens,
        })

        resp = %{
          response:    text,
          model:       model,
          tokens:      %{in: usage.input_tokens, out: usage.output_tokens},
          latency_ms:  latency_ms
        }

        log_routing(agent_name, primary, route, resp, true, ctx, nil)
        {:ok, resp}

      {:error, reason} ->
        Logger.warning("[sigma/llm] #{model} 실패 (#{inspect(reason)}) — agent=#{agent_name}, 다음 폴백 시도")
        try_routes(agent_name, remaining, prompt, opts, ctx, primary)
    end
  end

  # -------------------------------------------------------------------
  # Private — context + logging
  # -------------------------------------------------------------------

  defp build_context(agent_name, prompt, opts, budget_ratio) do
    %{
      prompt_tokens:       estimate_tokens(prompt),
      budget_ratio:        budget_ratio,
      urgency:             Keyword.get(opts, :urgency, :medium),
      task_type:           Keyword.get(opts, :task_type, infer_task_type(agent_name)),
      recent_failure_rate: safe_failure_rate(agent_name)
    }
  end

  defp estimate_tokens(text) when is_binary(text) do
    String.length(text) |> div(3) |> max(1)
  end
  defp estimate_tokens(_), do: 500

  defp infer_task_type(agent) do
    case to_string(agent) do
      "self_rag.retrieve_gate" -> :binary_classification
      "self_rag.relevance"     -> :batch_filtering
      "reflexion"              -> :structured_reasoning
      "espl.crossover"         -> :creative_generation
      "espl.mutation"          -> :creative_generation
      "principle.critique"     -> :structured_reasoning
      _                        -> :unknown
    end
  end

  defp safe_failure_rate(agent_name) do
    Sigma.V2.LLM.RoutingLog.recent_failure_rate(agent_name)
  rescue
    _ -> 0.0
  end

  defp log_routing(agent_name, primary, used_route, resp, ok, ctx, err_reason) do
    Sigma.V2.LLM.RoutingLog.record(%{
      agent_name:         to_string(agent_name),
      model_primary:      to_string(primary),
      model_used:         if(used_route, do: to_string(used_route), else: nil),
      fallback_used:      used_route != nil and used_route != primary,
      prompt_tokens:      ctx[:prompt_tokens],
      response_tokens:    resp && get_in(resp, [:tokens, :out]),
      latency_ms:         resp && resp[:latency_ms],
      cost_usd:           nil,
      response_ok:        ok,
      error_reason:       err_reason,
      urgency:            ctx[:urgency],
      task_type:          ctx[:task_type],
      budget_ratio:       ctx[:budget_ratio],
      recommended_reason: nil
    })
  end

  # -------------------------------------------------------------------
  # Private — Anthropic API
  # -------------------------------------------------------------------

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
             input_tokens:  Map.get(usage, "input_tokens", 0),
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
