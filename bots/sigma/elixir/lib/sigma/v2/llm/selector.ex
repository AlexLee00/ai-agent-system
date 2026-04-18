defmodule Sigma.V2.LLM.Selector do
  @moduledoc """
  시그마 LLM 게이트웨이 v2 — Hub 경유 라우팅 + 직접 Anthropic 폴백.

  라우팅 전략 (마스터 결정 2026-04-18):
    Primary:  Hub /hub/llm/call → Claude Code OAuth → Groq 폴백
    Fallback: Anthropic API 직접 호출 (kill switch off 또는 Hub 장애 시)

  환경변수:
    LLM_HUB_ROUTING_ENABLED=true  → Hub 경유 활성화 (기본 false)
    LLM_HUB_ROUTING_SHADOW=true   → Shadow Mode: 양쪽 병렬 실행, 직접호출 결과 반환
    HUB_BASE_URL                  → Hub 주소 (기본 http://localhost:7788)
    HUB_AUTH_TOKEN                → Hub Bearer 토큰

  Recommender: 6차원 룰 기반 (유지 — provider 매핑만 Hub가 처리)
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

  # 에이전트별 정적 정책 (Recommender 실패 시 폴백)
  # packages/core/lib/llm-model-selector.ts sigma.agent_policy 동기화
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

  @doc "에이전트 이름에 대한 정적 LLM 정책 반환."
  def policy_for(agent_name) do
    Map.get(@agent_policies, to_string(agent_name), @default_policy)
  end

  @doc """
  agent_name + prompt → LLM 호출 (Recommender + Hub 경유 or 직접 Anthropic + fallback 포함).

  반환: {:ok, %{response, model, provider, tokens, latency_ms}} | {:error, reason}
  """
  def call_with_fallback(agent_name, prompt, opts \\ []) do
    case Sigma.V2.LLM.CostTracker.check_budget() do
      {:ok, budget_ratio} ->
        context = build_context(agent_name, prompt, opts, budget_ratio)

        {primary, fallback} =
          case Sigma.V2.LLM.Recommender.recommend(agent_name, context) do
            {:ok, %{primary: p, fallback: f}} ->
              Logger.info("[sigma/llm] #{agent_name} → #{p} (Recommender)")
              {p, f}

            _ ->
              policy = policy_for(agent_name)
              {policy.route, policy.fallback}
          end

        cond do
          Sigma.V2.LLM.HubClient.shadow?() ->
            call_shadow(agent_name, prompt, primary, fallback, opts, context)

          Sigma.V2.LLM.HubClient.enabled?() ->
            call_via_hub(agent_name, prompt, primary, fallback, opts, context)

          true ->
            call_direct(agent_name, [primary | fallback], prompt, opts, context, primary)
        end

      {:error, :budget_exceeded} ->
        Logger.error("[sigma/llm] 일일 예산 초과 — agent=#{agent_name}")
        {:error, :budget_exceeded}
    end
  end

  # -------------------------------------------------------------------
  # Private — Hub 경유 호출
  # -------------------------------------------------------------------

  defp call_via_hub(agent_name, prompt, primary, fallback, opts, context) do
    request = %{
      prompt:          prompt,
      abstract_model:  primary,
      system_prompt:   opts[:system],
      timeout_ms:      opts[:timeout_ms] || 60_000,
      agent:           agent_name,
      urgency:         context[:urgency],
      task_type:       context[:task_type],
    }

    case Sigma.V2.LLM.HubClient.call(request) do
      {:ok, hub_resp} ->
        resp = %{
          response:   hub_resp.result,
          model:      hub_resp.provider,
          provider:   hub_resp.provider,
          tokens:     %{in: 0, out: 0},
          latency_ms: hub_resp.latency_ms
        }

        Sigma.V2.LLM.CostTracker.track_tokens(%{
          agent:     to_string(agent_name),
          model:     hub_resp.provider,
          provider:  hub_resp.provider,
          tokens_in: 0,
          tokens_out: 0,
          cost_usd:  hub_resp.cost_usd,
        })

        log_routing(agent_name, primary, :hub, resp, true, context, nil, hub_resp.provider)
        {:ok, resp}

      {:error, reason} ->
        Logger.warning("[sigma/llm] Hub 호출 실패 (#{inspect(reason)}) — agent=#{agent_name}, 직접 호출 fallback")
        call_direct(agent_name, [primary | fallback], prompt, opts, context, primary)
    end
  end

  # -------------------------------------------------------------------
  # Private — Shadow Mode: 양쪽 병렬 실행
  # -------------------------------------------------------------------

  defp call_shadow(agent_name, prompt, primary, fallback, opts, context) do
    hub_task    = Task.async(fn -> call_via_hub(agent_name, prompt, primary, fallback, opts, context) end)
    direct_task = Task.async(fn -> call_direct(agent_name, [primary | fallback], prompt, opts, context, primary) end)

    hub_result    = Task.yield(hub_task,    65_000) || Task.shutdown(hub_task)
    direct_result = Task.yield(direct_task, 65_000) || Task.shutdown(direct_task)

    hub_r    = unwrap_task(hub_result)
    direct_r = unwrap_task(direct_result)

    log_shadow_comparison(agent_name, hub_r, direct_r)

    # Shadow Mode: 항상 직접 호출 결과 반환 (안전)
    direct_r
  end

  defp unwrap_task({:ok, result}), do: result
  defp unwrap_task(nil),           do: {:error, :task_timeout}
  defp unwrap_task(_),             do: {:error, :task_error}

  defp log_shadow_comparison(agent_name, hub_r, direct_r) do
    hub_ok     = match?({:ok, _}, hub_r)
    direct_ok  = match?({:ok, _}, direct_r)

    Logger.info("[sigma/llm/shadow] #{agent_name} — hub=#{hub_ok}, direct=#{direct_ok}")

    if hub_ok and direct_ok do
      {:ok, hub_resp}    = hub_r
      {:ok, direct_resp} = direct_r
      latency_diff = (hub_resp[:latency_ms] || 0) - (direct_resp[:latency_ms] || 0)
      Logger.info("[sigma/llm/shadow] #{agent_name} 레이턴시 차이: #{latency_diff}ms (hub - direct)")
    end
  end

  # -------------------------------------------------------------------
  # Private — 직접 Anthropic API 호출 (레거시/fallback)
  # -------------------------------------------------------------------

  defp call_direct(agent_name, [], _prompt, _opts, ctx, primary) do
    Logger.error("[sigma/llm] 모든 route 실패 — agent=#{agent_name}")
    log_routing(agent_name, primary, nil, nil, false, ctx, "all_routes_failed", "direct_anthropic")
    {:error, :all_routes_failed}
  end

  defp call_direct(agent_name, [route | remaining], prompt, opts, ctx, primary) do
    timeout    = Map.get(@default_timeouts, route, 30_000)
    {_prov, model} = route_to_model(route)
    max_tokens = Keyword.get(opts, :max_tokens, 1024)
    system     = Keyword.get(opts, :system)

    start_ms = System.monotonic_time(:millisecond)

    case call_anthropic(model, prompt, system, max_tokens, timeout) do
      {:ok, text, usage} ->
        latency_ms = System.monotonic_time(:millisecond) - start_ms

        Sigma.V2.LLM.CostTracker.track_tokens(%{
          agent:     to_string(agent_name),
          model:     model,
          provider:  "direct_anthropic",
          tokens_in: usage.input_tokens,
          tokens_out: usage.output_tokens,
        })

        resp = %{
          response:   text,
          model:      model,
          provider:   "direct_anthropic",
          tokens:     %{in: usage.input_tokens, out: usage.output_tokens},
          latency_ms: latency_ms
        }

        log_routing(agent_name, primary, route, resp, true, ctx, nil, "direct_anthropic")
        {:ok, resp}

      {:error, reason} ->
        Logger.warning("[sigma/llm] #{model} 실패 (#{inspect(reason)}) — agent=#{agent_name}, 다음 폴백 시도")
        call_direct(agent_name, remaining, prompt, opts, ctx, primary)
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

  defp log_routing(agent_name, primary, used_route, resp, ok, ctx, err_reason, provider) do
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
      recommended_reason: nil,
      provider:           provider,
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

  defp route_to_model(:anthropic_haiku),  do: {:anthropic, "claude-haiku-4-5-20251001"}
  defp route_to_model(:anthropic_sonnet), do: {:anthropic, "claude-sonnet-4-6"}
  defp route_to_model(:anthropic_opus),   do: {:anthropic, "claude-opus-4-7"}
  defp route_to_model(_),                 do: {:anthropic, "claude-haiku-4-5-20251001"}
end
