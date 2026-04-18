defmodule Luna.V2.LLM.Selector do
  @moduledoc """
  루나 V2 LLM 게이트웨이 — Hub 경유 라우팅 + 직접 Anthropic 폴백.

  라우팅 전략:
    Primary:  Hub /hub/llm/call → Claude Code OAuth → Groq 폴백
    Fallback: Anthropic API 직접 호출 (Hub 장애 시)

  환경변수:
    LUNA_LLM_HUB_ROUTING_ENABLED=true  → Hub 경유 활성화 (기본 false)
    LUNA_LLM_HUB_ROUTING_SHADOW=true   → Shadow Mode: 양쪽 병렬 실행, 직접호출 결과 반환
    HUB_BASE_URL                       → Hub 주소 (기본 http://localhost:7788)
    LUNA_LLM_DAILY_BUDGET_USD          → 일일 예산 (기본 $30)

  공개 API:
    complete/3           — (agent_name, messages, opts) → {:ok, content} | {:error, reason}
    call_with_fallback/3 — 구버전 호환 래퍼
  """

  require Logger

  @anthropic_api_url "https://api.anthropic.com/v1/messages"
  @anthropic_version "2023-06-01"

  @default_timeouts %{
    anthropic_haiku:  15_000,
    anthropic_sonnet: 30_000,
    anthropic_opus:   60_000
  }

  @agent_policies %{
    "luna.commander"             => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "luna.decision_rationale"    => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "luna.rag.query_planner"     => %{route: :anthropic_haiku,  fallback: []},
    "luna.rag_query_planner"     => %{route: :anthropic_haiku,  fallback: []},
    "luna.rag.multi_source"      => %{route: :anthropic_haiku,  fallback: []},
    "luna.rag.quality_evaluator" => %{route: :anthropic_haiku,  fallback: [:anthropic_sonnet]},
    "luna.rag.response_synth"    => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "luna.self_rewarding_judge"  => %{route: :anthropic_haiku,  fallback: [:anthropic_sonnet]},
    "luna.reflexion"             => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "luna.espl"                  => %{route: :anthropic_haiku,  fallback: [:anthropic_sonnet]},
    "luna.principle.critique"    => %{route: :anthropic_opus,   fallback: [:anthropic_sonnet]},
    "luna.mapek.analyzer"        => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "luna.strategy.validator"    => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
  }

  @default_policy %{route: :anthropic_haiku, fallback: []}

  @doc "에이전트 이름에 대한 정적 LLM 정책 반환."
  def policy_for(agent_name) do
    Map.get(@agent_policies, to_string(agent_name), @default_policy)
  end

  @doc """
  agent_name + messages → LLM 호출.

  opts:
    :max_tokens — 최대 출력 토큰 (기본 1024)
    :system     — 시스템 프롬프트 (string | nil)
    :urgency    — :high | :medium | :low (기본 :medium)
    :task_type  — 작업 유형 atom

  반환: {:ok, content_string} | {:error, reason}
  """
  def complete(agent_name, messages, opts \\ []) do
    case safe_budget_check() do
      {:ok, budget_ratio} ->
        context = build_context(agent_name, messages, opts, budget_ratio)

        {primary, fallback_chain} =
          case Luna.V2.LLM.Recommender.recommend(agent_name, context) do
            {:ok, %{primary: p, fallback: f, reason: reason}} ->
              Logger.info("[루나V2 LLM] #{agent_name} → #{p} (#{reason})")
              {p, f}

            _ ->
              policy = policy_for(agent_name)
              {policy.route, policy.fallback}
          end

        all_routes =
          ([primary | fallback_chain] ++ [:anthropic_haiku])
          |> Enum.uniq()

        cond do
          Luna.V2.LLM.HubClient.shadow?() ->
            call_shadow(agent_name, messages, primary, fallback_chain, all_routes, opts, context)

          Luna.V2.LLM.HubClient.enabled?() ->
            call_via_hub(agent_name, messages, primary, fallback_chain, all_routes, opts, context)

          true ->
            call_direct(agent_name, all_routes, messages, opts, context, primary)
        end

      {:error, :budget_exceeded} ->
        Logger.error("[루나V2 LLM] 일일 예산 초과 — agent=#{agent_name}")
        {:error, :budget_exceeded}
    end
  end

  @doc "구버전 호환 래퍼 — complete/3 위임."
  def call_with_fallback(agent_name, prompt, opts \\ []) when is_binary(prompt) do
    complete(agent_name, [%{role: "user", content: prompt}], opts)
  end

  # -------------------------------------------------------------------
  # Private — Hub 경유 호출
  # -------------------------------------------------------------------

  defp call_via_hub(agent_name, messages, primary, _fallback_chain, all_routes, opts, context) do
    prompt     = messages_to_prompt(messages)
    system_msg = Keyword.get(opts, :system)

    request = %{
      prompt:         prompt,
      abstract_model: primary,
      system_prompt:  system_msg,
      timeout_ms:     opts[:timeout_ms] || 60_000,
      agent:          agent_name,
      urgency:        context[:urgency],
      task_type:      context[:task_type],
    }

    case Luna.V2.LLM.HubClient.call(request) do
      {:ok, hub_resp} ->
        abstract_model_str = to_string(primary)
        safe_track_tokens(%{
          agent:         to_string(agent_name),
          model:         abstract_model_str,
          provider:      hub_resp.provider,
          tokens_input:  0,
          tokens_output: 0,
          cost_usd:      hub_resp.cost_usd,
        })

        resp = %{
          content:    hub_resp.result,
          model:      abstract_model_str,
          tokens:     %{in: 0, out: 0},
          latency_ms: hub_resp.latency_ms
        }

        log_routing(agent_name, primary, :hub, resp, true, context, nil, hub_resp.provider)
        {:ok, hub_resp.result}

      {:error, reason} ->
        Logger.warning("[루나V2 LLM] Hub 호출 실패 (#{inspect(reason)}) — agent=#{agent_name}, 직접 호출 fallback")
        call_direct(agent_name, all_routes, messages, opts, context, primary)
    end
  end

  # -------------------------------------------------------------------
  # Private — Shadow Mode
  # -------------------------------------------------------------------

  defp call_shadow(agent_name, messages, primary, fallback_chain, all_routes, opts, context) do
    hub_task = Task.async(fn ->
      call_via_hub(agent_name, messages, primary, fallback_chain, all_routes, opts, context)
    end)
    direct_task = Task.async(fn ->
      call_direct(agent_name, all_routes, messages, opts, context, primary)
    end)

    hub_result    = Task.yield(hub_task,    65_000) || Task.shutdown(hub_task)
    direct_result = Task.yield(direct_task, 65_000) || Task.shutdown(direct_task)

    hub_r    = unwrap_task(hub_result)
    direct_r = unwrap_task(direct_result)

    log_shadow_comparison(agent_name, hub_r, direct_r)
    direct_r
  end

  defp unwrap_task({:ok, result}), do: result
  defp unwrap_task(nil),           do: {:error, :task_timeout}
  defp unwrap_task(_),             do: {:error, :task_error}

  defp log_shadow_comparison(agent_name, hub_r, direct_r) do
    hub_ok    = match?({:ok, _}, hub_r)
    direct_ok = match?({:ok, _}, direct_r)
    Logger.info("[루나V2 LLM/shadow] #{agent_name} — hub=#{hub_ok}, direct=#{direct_ok}")
  end

  # -------------------------------------------------------------------
  # Private — 직접 Anthropic API 호출
  # -------------------------------------------------------------------

  defp call_direct(agent_name, [], _messages, _opts, ctx, primary) do
    Logger.error("[루나V2 LLM] 모든 route 실패 — agent=#{agent_name}")
    log_routing(agent_name, primary, nil, nil, false, ctx, "all_routes_failed", "direct_anthropic")
    {:error, :all_routes_failed}
  end

  defp call_direct(agent_name, [route | remaining], messages, opts, ctx, primary) do
    timeout    = Map.get(@default_timeouts, route, 30_000)
    {_prov, model} = route_to_model(route)
    max_tokens = Keyword.get(opts, :max_tokens, 1024)
    system     = Keyword.get(opts, :system)

    start_ms = System.monotonic_time(:millisecond)

    case call_anthropic(model, messages, system, max_tokens, timeout) do
      {:ok, content, usage} ->
        latency_ms = System.monotonic_time(:millisecond) - start_ms

        safe_track_tokens(%{
          agent:         to_string(agent_name),
          model:         model,
          provider:      "direct_anthropic",
          tokens_input:  usage.input_tokens,
          tokens_output: usage.output_tokens
        })

        resp = %{
          content:    content,
          model:      model,
          tokens:     %{in: usage.input_tokens, out: usage.output_tokens},
          latency_ms: latency_ms
        }

        log_routing(agent_name, primary, route, resp, true, ctx, nil, "direct_anthropic")
        {:ok, content}

      {:error, reason} ->
        Logger.warning("[루나V2 LLM] #{model} 실패 (#{inspect(reason)}) — agent=#{agent_name}, 다음 폴백 시도")
        call_direct(agent_name, remaining, messages, opts, ctx, primary)
    end
  end

  # -------------------------------------------------------------------
  # Private — context 구성
  # -------------------------------------------------------------------

  defp build_context(agent_name, messages, opts, budget_ratio) do
    %{
      prompt_tokens:       estimate_tokens(messages),
      budget_ratio:        budget_ratio,
      urgency:             Keyword.get(opts, :urgency, :medium),
      task_type:           Keyword.get(opts, :task_type, infer_task_type(agent_name)),
      recent_failure_rate: safe_failure_rate(agent_name)
    }
  end

  defp estimate_tokens(messages) when is_list(messages) do
    messages
    |> Enum.map(fn
      %{content: c} when is_binary(c)     -> String.length(c)
      %{"content" => c} when is_binary(c) -> String.length(c)
      _                                    -> 0
    end)
    |> Enum.sum()
    |> div(3)
    |> max(1)
  end

  defp estimate_tokens(text) when is_binary(text), do: String.length(text) |> div(3) |> max(1)
  defp estimate_tokens(_), do: 500

  defp infer_task_type(agent) do
    case to_string(agent) do
      "luna.decision_rationale"   -> :rationale_generation
      "luna.rag.query_planner"    -> :query_decomposition
      "luna.rag_query_planner"    -> :query_decomposition
      "luna.rag.multi_source"     -> :keyword_extraction
      "luna.self_rewarding_judge" -> :trade_evaluation
      "luna.reflexion"            -> :structured_reasoning
      "luna.espl"                 -> :structured_reasoning
      "luna.principle.critique"   -> :structured_reasoning
      "luna.mapek.analyzer"       -> :structured_reasoning
      "luna.strategy.validator"   -> :structured_reasoning
      _                           -> :unknown
    end
  end

  defp safe_failure_rate(agent_name) do
    Luna.V2.LLM.RoutingLog.recent_failure_rate(agent_name)
  rescue
    _ -> 0.0
  catch
    :exit, _ -> 0.0
  end

  defp safe_budget_check do
    Luna.V2.LLM.CostTracker.check_budget()
  rescue
    _ -> {:ok, 1.0}
  catch
    :exit, _ ->
      Logger.debug("[루나V2 LLM] CostTracker 미기동 — 예산 체크 기본값 사용")
      {:ok, 1.0}
  end

  defp safe_track_tokens(entry) do
    Luna.V2.LLM.CostTracker.track_tokens(entry)
  rescue
    _ -> {:ok, entry}
  catch
    :exit, _ ->
      Logger.debug("[루나V2 LLM] CostTracker 미기동 — 토큰 기록 생략")
      {:ok, entry}
  end

  defp messages_to_prompt(messages) when is_list(messages) do
    messages
    |> Enum.reject(fn m -> to_string(Map.get(m, :role, Map.get(m, "role", ""))) == "system" end)
    |> Enum.map(fn
      %{role: r, content: c}         -> if to_string(r) == "user", do: c, else: "[#{r}]: #{c}"
      %{"role" => r, "content" => c} -> if r == "user", do: c, else: "[#{r}]: #{c}"
      _                              -> ""
    end)
    |> Enum.reject(&(&1 == ""))
    |> Enum.join("\n\n")
  end

  defp messages_to_prompt(text) when is_binary(text), do: text
  defp messages_to_prompt(_), do: ""

  # -------------------------------------------------------------------
  # Private — 라우팅 로그
  # -------------------------------------------------------------------

  defp log_routing(agent_name, primary, used_route, resp, ok, ctx, err_reason, provider) do
    safe_record_routing(%{
      agent_name:         to_string(agent_name),
      model_primary:      to_string(primary),
      model_used:         if(used_route, do: to_string(used_route), else: nil),
      fallback_used:      used_route != nil and used_route != primary,
      tokens_input:       ctx[:prompt_tokens],
      tokens_output:      resp && get_in(resp, [:tokens, :out]),
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

  defp safe_record_routing(entry) do
    Luna.V2.LLM.RoutingLog.record(entry)
  rescue
    _ -> :ok
  catch
    :exit, _ ->
      Logger.debug("[루나V2 LLM] RoutingLog 미기동 — 라우팅 기록 생략")
      :ok
  end

  # -------------------------------------------------------------------
  # Private — Anthropic API 호출
  # -------------------------------------------------------------------

  defp call_anthropic(model, messages, system, max_tokens, timeout) do
    key = System.get_env("ANTHROPIC_API_KEY")

    if is_nil(key) or key == "" do
      {:error, :no_api_key}
    else
      normalized =
        case messages do
          msgs when is_list(msgs)   -> msgs
          text when is_binary(text) -> [%{role: "user", content: text}]
          _                         -> [%{role: "user", content: inspect(messages)}]
        end

      body = %{model: model, max_tokens: max_tokens, messages: normalized}
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

        {:ok, %{status: status, body: resp_body}} ->
          {:error, {:http_error, status, resp_body}}

        {:error, reason} ->
          {:error, reason}
      end
    end
  end

  defp route_to_model(:anthropic_haiku),  do: {:anthropic, "claude-haiku-4-5-20251001"}
  defp route_to_model(:anthropic_sonnet), do: {:anthropic, "claude-sonnet-4-6"}
  defp route_to_model(:anthropic_opus),   do: {:anthropic, "claude-opus-4-7"}
  defp route_to_model(_),                 do: {:anthropic, "claude-haiku-4-5-20251001"}
end
