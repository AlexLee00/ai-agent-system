defmodule Darwin.V2.LLM.Selector do
  @moduledoc """
  다윈 V2 LLM 게이트웨이 — Anthropic API 전용 + Recommender 통합.

  Claude 전용 (마스터 결정 2026-04-18).
  Recommender가 컨텍스트 기반 동적 모델 추천, 정적 정책은 폴백.
  모든 라우팅 결과는 RoutingLog에 기록.

  Kill switch: Application.get_env(:darwin, :kill_switch, true) + 예산 초과 시
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
  # darwin.* 키: V2 네임스페이스 / 단축 키: 구버전 호환
  @agent_policies %{
    # V2 네임스페이스
    "darwin.scanner"        => %{route: :anthropic_haiku,  fallback: [:anthropic_sonnet]},
    "darwin.evaluator"      => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "darwin.planner"        => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "darwin.edison"         => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "darwin.verifier"       => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "darwin.commander"      => %{route: :anthropic_opus,   fallback: [:anthropic_sonnet]},
    "darwin.reflexion"      => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
    "darwin.espl"           => %{route: :anthropic_haiku,  fallback: [:anthropic_sonnet]},
    "darwin.self_rag"       => %{route: :anthropic_haiku,  fallback: []},
    # 구버전 호환 키
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
  agent_name + messages → LLM 호출 (Recommender + Kill Switch + 예산 체크 + 폴백 포함).

  opts:
    :max_tokens   — 최대 출력 토큰 (기본 1024)
    :system       — 시스템 프롬프트 (string | nil)
    :urgency      — :high | :medium | :low (기본 :medium)
    :task_type    — 작업 유형 atom (기본: agent 이름에서 추론)

  반환: {:ok, content_string} | {:error, reason}
  Kill switch=true + 예산 초과 → {:error, :kill_switch}
  """
  def complete(agent_name, messages, opts \\ []) do
    kill_switch_enabled = Application.get_env(:darwin, :kill_switch, true)

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

        try_routes(agent_name, all_routes, messages, opts, context, primary)

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
  # Private — route chain
  # -------------------------------------------------------------------

  defp try_routes(agent_name, [], _messages, _opts, ctx, primary) do
    Logger.error("[다윈V2 LLM] 모든 route 실패 — agent=#{agent_name}")
    log_routing(agent_name, primary, nil, nil, false, ctx, "all_routes_failed")
    {:error, :all_routes_failed}
  end

  defp try_routes(agent_name, [route | remaining], messages, opts, ctx, primary) do
    timeout = Map.get(@default_timeouts, route, 30_000)
    {_provider, model} = route_to_model(route)
    max_tokens = Keyword.get(opts, :max_tokens, 1024)
    system = Keyword.get(opts, :system)

    start_ms = System.monotonic_time(:millisecond)

    case call_anthropic(model, messages, system, max_tokens, timeout) do
      {:ok, content, usage} ->
        latency_ms = System.monotonic_time(:millisecond) - start_ms

        Darwin.V2.LLM.CostTracker.track_tokens(%{
          agent:         to_string(agent_name),
          model:         model,
          provider:      "anthropic",
          tokens_input:  usage.input_tokens,
          tokens_output: usage.output_tokens
        })

        resp = %{
          content:    content,
          model:      model,
          tokens:     %{in: usage.input_tokens, out: usage.output_tokens},
          latency_ms: latency_ms
        }

        log_routing(agent_name, primary, route, resp, true, ctx, nil)
        {:ok, content}

      {:error, reason} ->
        Logger.warning("[다윈V2 LLM] #{model} 실패 (#{inspect(reason)}) — agent=#{agent_name}, 다음 폴백 시도")
        try_routes(agent_name, remaining, messages, opts, ctx, primary)
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

  # -------------------------------------------------------------------
  # Private — 라우팅 로그
  # -------------------------------------------------------------------

  defp log_routing(agent_name, primary, used_route, resp, ok, ctx, err_reason) do
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
      recommended_reason: nil
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
    Application.get_env(:darwin, :anthropic_api_key) ||
      System.get_env("ANTHROPIC_API_KEY") ||
      System.get_env("DARWIN_ANTHROPIC_API_KEY")
  end

  defp route_to_model(:anthropic_haiku),  do: {:anthropic, "claude-haiku-4-5-20251001"}
  defp route_to_model(:anthropic_sonnet), do: {:anthropic, "claude-sonnet-4-6"}
  defp route_to_model(:anthropic_opus),   do: {:anthropic, "claude-opus-4-7"}
  defp route_to_model(_),                 do: {:anthropic, "claude-haiku-4-5-20251001"}
end
