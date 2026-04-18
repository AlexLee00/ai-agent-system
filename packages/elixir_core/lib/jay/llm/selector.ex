defmodule Jay.Core.LLM.Selector do
  @moduledoc """
  팀 독립적 LLM Selector 공용 레이어.

  사용법:
    use Jay.Core.LLM.Selector, policy_module: MyTeam.V2.LLM.Policy

  policy_module은 Jay.Core.LLM.Policy behaviour를 구현해야 한다.

  공개 API (주입됨):
    complete/3         — (agent_name, messages, opts) → {:ok, content} | {:error, reason}
    call_with_fallback/3 — (agent_name, prompt, opts) → {:ok, content} | {:error, reason}
    policy_for/1       — 에이전트 정적 정책 조회
  """

  defmacro __using__(opts) do
    policy_module = Keyword.fetch!(opts, :policy_module)

    quote do
      require Logger

      @policy_module unquote(policy_module)

      @doc "에이전트 이름에 대한 정적 LLM 정책 반환."
      def policy_for(agent_name) do
        policies = @policy_module.agent_policies()
        Map.get(policies, to_string(agent_name), @policy_module.default_policy())
      end

      @doc """
      agent_name + messages → LLM 호출.
      반환: {:ok, content_string} | {:error, reason}
      """
      def complete(agent_name, messages, opts \\ []) do
        Jay.Core.LLM.Selector.Impl.complete(@policy_module, agent_name, messages, opts)
      end

      @doc "바이너리 프롬프트 래퍼 — complete/3 위임. 팀 모듈에서 override 가능."
      def call_with_fallback(agent_name, prompt, opts \\ []) when is_binary(prompt) do
        complete(agent_name, [%{role: "user", content: prompt}], opts)
      end

      defoverridable call_with_fallback: 3
    end
  end

  defmodule Impl do
    @moduledoc false

    require Logger

    @anthropic_api_url "https://api.anthropic.com/v1/messages"
    @anthropic_version "2023-06-01"

    @default_timeouts %{
      anthropic_haiku:  15_000,
      anthropic_sonnet: 30_000,
      anthropic_opus:   60_000
    }

    def complete(policy_module, agent_name, messages, opts) do
      case safe_budget_check(policy_module) do
        {:ok, budget_ratio} ->
          context = build_context(policy_module, agent_name, messages, opts, budget_ratio)

          {primary, fallback_chain} =
            case safe_recommend(policy_module, agent_name, context) do
              {:ok, %{primary: p, fallback: f, reason: reason}} ->
                log_prefix = policy_module.log_prefix()
                Logger.info("#{log_prefix} #{agent_name} → #{p} (#{reason})")
                {p, f}
              _ ->
                policies = policy_module.agent_policies()
                policy   = Map.get(policies, to_string(agent_name), policy_module.default_policy())
                {policy.route, policy.fallback}
            end

          all_routes =
            ([primary | fallback_chain] ++ [:anthropic_haiku])
            |> Enum.uniq()

          cond do
            policy_module.hub_shadow?() ->
              call_shadow(policy_module, agent_name, messages, primary, fallback_chain, all_routes, opts, context)

            policy_module.hub_routing_enabled?() ->
              call_via_hub(policy_module, agent_name, messages, primary, all_routes, opts, context)

            true ->
              call_direct(policy_module, agent_name, all_routes, messages, opts, context, primary)
          end

        {:error, :budget_exceeded} ->
          kill_switch_active? =
            function_exported?(policy_module, :kill_switch?, 0) and policy_module.kill_switch?()

          log_prefix = policy_module.log_prefix()

          if kill_switch_active? do
            Logger.error("#{log_prefix} Kill switch 발동 — 예산 초과, agent=#{agent_name}")
            {:error, :kill_switch}
          else
            Logger.error("#{log_prefix} 일일 예산 초과 — agent=#{agent_name}")
            {:error, :budget_exceeded}
          end
      end
    end

    # -------------------------------------------------------------------
    # Private — Hub 경유 호출
    # -------------------------------------------------------------------

    defp call_via_hub(policy_module, agent_name, messages, primary, all_routes, opts, context) do
      hub_module  = hub_client_module(policy_module)
      log_prefix  = policy_module.log_prefix()

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

      case hub_module.call(request) do
        {:ok, hub_resp} ->
          abstract_model_str = to_string(primary)
          safe_track_tokens(policy_module, %{
            agent:         to_string(agent_name),
            model:         abstract_model_str,
            provider:      hub_resp.provider,
            tokens_in:     0,
            tokens_out:    0,
            cost_usd:      hub_resp.cost_usd,
          })

          resp = %{
            content:    hub_resp.result,
            model:      abstract_model_str,
            tokens:     %{in: 0, out: 0},
            latency_ms: hub_resp.latency_ms
          }

          log_routing(policy_module, agent_name, primary, :hub, resp, true, context, nil, hub_resp.provider)
          {:ok, hub_resp.result}

        {:error, reason} ->
          Logger.warning("#{log_prefix} Hub 호출 실패 (#{inspect(reason)}) — agent=#{agent_name}, 직접 호출 fallback")
          call_direct(policy_module, agent_name, all_routes, messages, opts, context, primary)
      end
    end

    # -------------------------------------------------------------------
    # Private — Shadow Mode
    # -------------------------------------------------------------------

    defp call_shadow(policy_module, agent_name, messages, primary, _fallback_chain, all_routes, opts, context) do
      log_prefix = policy_module.log_prefix()

      hub_task    = Task.async(fn ->
        call_via_hub(policy_module, agent_name, messages, primary, all_routes, opts, context)
      end)
      direct_task = Task.async(fn ->
        call_direct(policy_module, agent_name, all_routes, messages, opts, context, primary)
      end)

      hub_result    = Task.yield(hub_task,    65_000) || Task.shutdown(hub_task)
      direct_result = Task.yield(direct_task, 65_000) || Task.shutdown(direct_task)

      hub_r    = unwrap_task(hub_result)
      direct_r = unwrap_task(direct_result)

      hub_ok    = match?({:ok, _}, hub_r)
      direct_ok = match?({:ok, _}, direct_r)
      Logger.info("#{log_prefix}/shadow #{agent_name} — hub=#{hub_ok}, direct=#{direct_ok}")

      direct_r
    end

    defp unwrap_task({:ok, result}), do: result
    defp unwrap_task(nil),           do: {:error, :task_timeout}
    defp unwrap_task(_),             do: {:error, :task_error}

    # -------------------------------------------------------------------
    # Private — 직접 Anthropic API 호출
    # -------------------------------------------------------------------

    defp call_direct(policy_module, agent_name, [], _messages, _opts, ctx, primary) do
      log_prefix = policy_module.log_prefix()
      Logger.error("#{log_prefix} 모든 route 실패 — agent=#{agent_name}")
      log_routing(policy_module, agent_name, primary, nil, nil, false, ctx, "all_routes_failed", "direct_anthropic")
      {:error, :all_routes_failed}
    end

    defp call_direct(policy_module, agent_name, [route | remaining], messages, opts, ctx, primary) do
      log_prefix = policy_module.log_prefix()
      timeout    = Map.get(@default_timeouts, route, 30_000)
      model      = route_to_model(route)
      max_tokens = Keyword.get(opts, :max_tokens, 1024)
      system     = Keyword.get(opts, :system)
      api_key    = policy_module.api_key()

      start_ms = System.monotonic_time(:millisecond)

      case call_anthropic(api_key, model, messages, system, max_tokens, timeout) do
        {:ok, content, usage} ->
          latency_ms = System.monotonic_time(:millisecond) - start_ms

          safe_track_tokens(policy_module, %{
            agent:         to_string(agent_name),
            model:         model,
            provider:      "direct_anthropic",
            tokens_in:     usage.input_tokens,
            tokens_out:    usage.output_tokens,
          })

          resp = %{
            content:    content,
            model:      model,
            tokens:     %{in: usage.input_tokens, out: usage.output_tokens},
            latency_ms: latency_ms
          }

          log_routing(policy_module, agent_name, primary, route, resp, true, ctx, nil, "direct_anthropic")
          {:ok, content}

        {:error, reason} ->
          Logger.warning("#{log_prefix} #{model} 실패 (#{inspect(reason)}) — agent=#{agent_name}, 다음 폴백 시도")
          call_direct(policy_module, agent_name, remaining, messages, opts, ctx, primary)
      end
    end

    # -------------------------------------------------------------------
    # Private — context 구성
    # -------------------------------------------------------------------

    defp build_context(policy_module, agent_name, messages, opts, budget_ratio) do
      %{
        prompt_tokens:       estimate_tokens(messages),
        budget_ratio:        budget_ratio,
        urgency:             Keyword.get(opts, :urgency, :medium),
        task_type:           Keyword.get(opts, :task_type, :unknown),
        recent_failure_rate: safe_failure_rate(policy_module, agent_name),
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

    # -------------------------------------------------------------------
    # Private — 라우팅 로그
    # -------------------------------------------------------------------

    defp log_routing(policy_module, agent_name, primary, used_route, resp, ok, ctx, err_reason, provider) do
      routing_log_module(policy_module).record(%{
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
    # Private — Anthropic API 호출
    # -------------------------------------------------------------------

    defp call_anthropic(key, model, messages, system, max_tokens, timeout) do
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

    defp route_to_model(:anthropic_haiku),  do: "claude-haiku-4-5-20251001"
    defp route_to_model(:anthropic_sonnet), do: "claude-sonnet-4-6"
    defp route_to_model(:anthropic_opus),   do: "claude-opus-4-7"
    defp route_to_model(_),                 do: "claude-haiku-4-5-20251001"

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
    # Private — 안전 호출 헬퍼
    # -------------------------------------------------------------------

    defp safe_budget_check(policy_module) do
      cost_tracker_module(policy_module).check_budget()
    rescue
      _ -> {:ok, 1.0}
    catch
      :exit, _ -> {:ok, 1.0}
    end

    defp safe_track_tokens(policy_module, entry) do
      cost_tracker_module(policy_module).track_tokens(entry)
    rescue
      _ -> {:ok, entry}
    catch
      :exit, _ -> {:ok, entry}
    end

    defp safe_failure_rate(policy_module, agent_name) do
      routing_log_module(policy_module).recent_failure_rate(agent_name)
    rescue
      _ -> 0.0
    catch
      :exit, _ -> 0.0
    end

    defp safe_recommend(policy_module, agent_name, context) do
      recommender_module(policy_module).recommend(agent_name, context)
    rescue
      _ -> {:error, :recommender_unavailable}
    catch
      :exit, _ -> {:error, :recommender_unavailable}
    end

    # sub-module 추론: Policy 모듈 네임스페이스에서 각 모듈 찾기
    defp hub_client_module(policy_module) do
      base = policy_module |> to_string() |> String.replace("Policy", "HubClient")
      String.to_existing_atom(base)
    rescue
      _ -> Jay.Core.LLM.HubClient.Impl
    end

    defp cost_tracker_module(policy_module) do
      base = policy_module |> to_string() |> String.replace("Policy", "CostTracker")
      String.to_existing_atom(base)
    rescue
      _ -> raise "CostTracker 모듈 없음: #{policy_module}"
    end

    defp routing_log_module(policy_module) do
      base = policy_module |> to_string() |> String.replace("Policy", "RoutingLog")
      String.to_existing_atom(base)
    rescue
      _ -> raise "RoutingLog 모듈 없음: #{policy_module}"
    end

    defp recommender_module(policy_module) do
      base = policy_module |> to_string() |> String.replace("Policy", "Recommender")
      String.to_existing_atom(base)
    rescue
      _ -> raise "Recommender 모듈 없음: #{policy_module}"
    end
  end
end
