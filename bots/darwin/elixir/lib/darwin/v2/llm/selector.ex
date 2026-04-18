defmodule Darwin.V2.LLM.Selector do
  @moduledoc """
  다윈 V2 LLM 게이트웨이 — Hub 경유 라우팅 + 직접 Anthropic 폴백.

  라우팅 전략 (마스터 결정 2026-04-18):
    Primary:  Hub /hub/llm/call → Claude Code OAuth → Groq 폴백
    Fallback: Anthropic API 직접 호출 (kill switch off 또는 Hub 장애 시)

  환경변수:
    LLM_HUB_ROUTING_ENABLED=true  → Hub 경유 활성화 (기본 false)
    LLM_HUB_ROUTING_SHADOW=true   → Shadow Mode: 양쪽 병렬 실행, 직접호출 결과 반환
    HUB_BASE_URL                  → Hub 주소 (기본 http://localhost:7788)

  Kill Switch: Darwin.V2.Config.kill_switch?() + 예산 초과 시
  {:error, :kill_switch} 반환.

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

  # 에이전트별 정적 정책 (Recommender 실패 시 폴백)
  @agent_policies %{
    "darwin.scanner"        => %{route: :anthropic_haiku,  fallback: [:anthropic_sonnet]},
    "darwin.evaluator"      => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "darwin.planner"        => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "darwin.edison"         => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "darwin.verifier"       => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "darwin.commander"      => %{route: :anthropic_opus,   fallback: [:anthropic_sonnet]},
    "darwin.reflexion"      => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "darwin.espl"           => %{route: :anthropic_haiku,  fallback: [:anthropic_sonnet]},
    "darwin.self_rag"                => %{route: :anthropic_haiku,  fallback: []},
    "darwin.self_rewarding_judge"    => %{route: :anthropic_haiku,  fallback: [:anthropic_sonnet]},
    "commander"             => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "evaluator"             => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "planner"               => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "implementor"           => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "verifier"              => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "applier"               => %{route: :anthropic_haiku,  fallback: []},
    "learner"               => %{route: :anthropic_haiku,  fallback: []},
    "scanner"               => %{route: :anthropic_haiku,  fallback: []},
    "reflexion"             => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "self_rag.retrieve"     => %{route: :anthropic_haiku,  fallback: []},
    "self_rag.relevance"    => %{route: :anthropic_haiku,  fallback: []},
    "espl.crossover"        => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "espl.mutation"         => %{route: :anthropic_haiku,  fallback: []},
    "principle.critique"    => %{route: :anthropic_opus,   fallback: [:anthropic_sonnet]}
  }

  @default_policy %{route: :anthropic_haiku, fallback: []}

  @doc "에이전트 이름에 대한 정적 LLM 정책 반환."
  def policy_for(agent_name) do
    Map.get(@agent_policies, to_string(agent_name), @default_policy)
  end

  @doc """
  agent_name + messages → LLM 호출 (Recommender + Hub 경유 or 직접 Anthropic + Kill Switch + fallback 포함).

  opts:
    :max_tokens   — 최대 출력 토큰 (기본 1024)
    :system       — 시스템 프롬프트 (string | nil)
    :urgency      — :high | :medium | :low (기본 :medium)
    :task_type    — 작업 유형 atom (기본: agent 이름에서 추론)

  반환: {:ok, content_string} | {:error, reason}
  Kill switch=true + 예산 초과 → {:error, :kill_switch}
  """
  def complete(agent_name, messages, opts \\ []) do
    kill_switch_enabled = Darwin.V2.Config.kill_switch?()

    case Darwin.V2.LLM.CostTracker.check_budget() do
      {:ok, budget_ratio} ->
        context = build_context(agent_name, messages, opts, budget_ratio)

        {primary, fallback_chain} =
          case Darwin.V2.LLM.Recommender.recommend(agent_name, context) do
            {:ok, %{primary: p, fallback: f, reason: reason}} ->
              Logger.info("[다윈V2 LLM] #{agent_name} → #{p} (#{reason})")
              {p, f}

            _ ->
              policy = policy_for(agent_name)
              {policy.route, policy.fallback}
          end

        # haiku를 최후 수단으로 보장
        all_routes =
          ([primary | fallback_chain] ++ [:anthropic_haiku])
          |> Enum.uniq()

        cond do
          Darwin.V2.LLM.HubClient.shadow?() ->
            call_shadow(agent_name, messages, primary, fallback_chain, all_routes, opts, context)

          Darwin.V2.LLM.HubClient.enabled?() ->
            call_via_hub(agent_name, messages, primary, fallback_chain, all_routes, opts, context)

          true ->
            call_direct(agent_name, all_routes, messages, opts, context, primary)
        end

      {:error, :budget_exceeded} ->
        if kill_switch_enabled do
          Logger.error("[다윈V2 LLM] Kill switch 발동 — 예산 초과, agent=#{agent_name}")
          {:error, :kill_switch}
        else
          Logger.error("[다윈V2 LLM] 일일 예산 초과 — agent=#{agent_name}")
          {:error, :budget_exceeded}
        end
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
    prompt       = messages_to_prompt(messages)
    system_msg   = Keyword.get(opts, :system)

    request = %{
      prompt:         prompt,
      abstract_model: primary,
      system_prompt:  system_msg,
      timeout_ms:     opts[:timeout_ms] || 60_000,
      agent:          agent_name,
      urgency:        context[:urgency],
      task_type:      context[:task_type],
    }

    case Darwin.V2.LLM.HubClient.call(request) do
      {:ok, hub_resp} ->
        abstract_model_str = to_string(primary)
        Darwin.V2.LLM.CostTracker.track_tokens(%{
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
        Logger.warning("[다윈V2 LLM] Hub 호출 실패 (#{inspect(reason)}) — agent=#{agent_name}, 직접 호출 fallback")
        call_direct(agent_name, all_routes, messages, opts, context, primary)
    end
  end

  # -------------------------------------------------------------------
  # Private — Shadow Mode: 양쪽 병렬 실행
  # -------------------------------------------------------------------

  defp call_shadow(agent_name, messages, primary, fallback_chain, all_routes, opts, context) do
    hub_task    = Task.async(fn ->
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

    # Shadow Mode: 항상 직접 호출 결과 반환 (안전)
    direct_r
  end

  defp unwrap_task({:ok, result}), do: result
  defp unwrap_task(nil),           do: {:error, :task_timeout}
  defp unwrap_task(_),             do: {:error, :task_error}

  defp log_shadow_comparison(agent_name, hub_r, direct_r) do
    hub_ok    = match?({:ok, _}, hub_r)
    direct_ok = match?({:ok, _}, direct_r)
    Logger.info("[다윈V2 LLM/shadow] #{agent_name} — hub=#{hub_ok}, direct=#{direct_ok}")
  end

  # -------------------------------------------------------------------
  # Private — 직접 Anthropic API 호출 (레거시/fallback)
  # -------------------------------------------------------------------

  defp call_direct(agent_name, [], _messages, _opts, ctx, primary) do
    Logger.error("[다윈V2 LLM] 모든 route 실패 — agent=#{agent_name}")
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

        Darwin.V2.LLM.CostTracker.track_tokens(%{
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
        Logger.warning("[다윈V2 LLM] #{model} 실패 (#{inspect(reason)}) — agent=#{agent_name}, 다음 폴백 시도")
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
      "darwin.scanner"     -> :keyword_extraction
      "darwin.evaluator"   -> :evaluation_scoring
      "darwin.planner"     -> :structured_reasoning
      "darwin.edison"      -> :code_generation
      "darwin.verifier"    -> :structured_reasoning
      "darwin.commander"   -> :structured_reasoning
      "darwin.reflexion"   -> :structured_reasoning
      "darwin.espl"        -> :creative_generation
      "darwin.self_rag"    -> :binary_classification
      "reflexion"          -> :structured_reasoning
      "espl.crossover"     -> :creative_generation
      "espl.mutation"      -> :creative_generation
      "principle.critique" -> :structured_reasoning
      "evaluator"          -> :structured_reasoning
      "planner"            -> :structured_reasoning
      _                    -> :unknown
    end
  end

  defp safe_failure_rate(agent_name) do
    Darwin.V2.LLM.RoutingLog.recent_failure_rate(agent_name)
  rescue
    _ -> 0.0
  end

  # messages 리스트 → Hub prompt 문자열 변환
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
    Darwin.V2.LLM.RoutingLog.record(%{
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

  # -------------------------------------------------------------------
  # Private — Anthropic API 호출
  # -------------------------------------------------------------------

  defp call_anthropic(model, messages, system, max_tokens, timeout) do
    key = api_key()

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

  defp api_key do
    Darwin.V2.Config.anthropic_api_key()
  end

  defp route_to_model(:anthropic_haiku),  do: {:anthropic, "claude-haiku-4-5-20251001"}
  defp route_to_model(:anthropic_sonnet), do: {:anthropic, "claude-sonnet-4-6"}
  defp route_to_model(:anthropic_opus),   do: {:anthropic, "claude-opus-4-7"}
  defp route_to_model(_),                 do: {:anthropic, "claude-haiku-4-5-20251001"}
end
