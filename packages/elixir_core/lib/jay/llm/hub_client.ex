defmodule Jay.Core.LLM.HubClient do
  @moduledoc """
  팀별 Hub HTTP 클라이언트 공용 레이어.

  사용법:
    use Jay.Core.LLM.HubClient,
      team: "sigma",
      routing_env: "LLM_HUB_ROUTING_ENABLED",   # 선택 (기본값)
      shadow_env:  "LLM_HUB_ROUTING_SHADOW"      # 선택 (기본값)
  """

  defmacro __using__(opts) do
    team = Keyword.fetch!(opts, :team)
    routing_env = Keyword.get(opts, :routing_env, "LLM_HUB_ROUTING_ENABLED")
    shadow_env = Keyword.get(opts, :shadow_env, "LLM_HUB_ROUTING_SHADOW")

    quote do
      require Logger

      @team unquote(team)
      @routing_env unquote(routing_env)
      @shadow_env unquote(shadow_env)

      @doc "Hub 라우팅 활성화 여부"
      def enabled?, do: System.get_env(@routing_env) == "true"

      @doc "Hub Shadow Mode 활성화 여부"
      def shadow?, do: System.get_env(@shadow_env) == "true"

      @doc """
      Hub /hub/llm/call 호출.
      반환: {:ok, %{result, provider, cost_usd, latency_ms}} | {:error, reason}
      """
      def call(request) when is_map(request) do
        Jay.Core.LLM.HubClient.Impl.call(request, @team)
      end
    end
  end

  defmodule Impl do
    @moduledoc false

    require Logger

    @hub_base_default "http://localhost:7788"
    @timeout 65_000

    def call(request, team) when is_map(request) and is_binary(team) do
      url = "#{hub_base()}/hub/llm/call"

      body = %{
        "prompt" => request[:prompt],
        "abstractModel" => to_string(request[:abstract_model] || :anthropic_haiku),
        "timeoutMs" => request[:timeout_ms] || 60_000,
        "agent" => request[:agent] && to_string(request[:agent]),
        "callerTeam" => team,
        "urgency" => normalize_hub_urgency(request[:urgency]),
        "taskType" => request[:task_type] && to_string(request[:task_type])
      }

      body =
        if request[:system_prompt],
          do: Map.put(body, "systemPrompt", request[:system_prompt]),
          else: body

      headers = [{"Authorization", "Bearer #{hub_token()}"}]

      case Req.post(url, json: body, headers: headers, receive_timeout: @timeout) do
        {:ok, %{status: status, body: response_body} = response} ->
          parse_http_response(status, response_body, response_retry_after(response))

        {:error, err} ->
          {:error, {:hub_request_failed, inspect(err)}}
      end
    end

    def parse_http_response(status, raw, retry_after) when is_binary(raw) do
      case Jason.decode(raw) do
        {:ok, body} -> parse_http_response(status, body, retry_after)
        _ -> {:error, {:json_parse_error, String.slice(raw, 0, 200)}}
      end
    end

    def parse_http_response(status, body, retry_after) when is_map(body) do
      if backpressure_body?(body) do
        {:error,
         {:hub_backpressure,
          %{
            status: status,
            code: error_code(body),
            retry_after_ms: retry_after_ms(body, retry_after),
            admission_scope: Map.get(body, "admissionScope")
          }}}
      else
        if status == 200,
          do: parse_response(body),
          else: {:error, {:hub_http_error, status, inspect(body)}}
      end
    end

    def parse_http_response(status, body, _retry_after) do
      {:error, {:hub_http_error, status, inspect(body)}}
    end

    def backpressure_reason?({:hub_backpressure, _meta}), do: true
    def backpressure_reason?(_reason), do: false

    defp parse_response(%{"ok" => true, "result" => result} = resp) do
      {:ok,
       %{
         result: result,
         provider: Map.get(resp, "provider", "unknown"),
         cost_usd: Map.get(resp, "totalCostUsd"),
         latency_ms: Map.get(resp, "durationMs", 0),
         fallback_count: Map.get(resp, "fallbackCount", 0)
       }}
    end

    defp parse_response(%{"ok" => false} = resp) do
      {:error, {:hub_call_failed, Map.get(resp, "error", "unknown")}}
    end

    defp parse_response(other) do
      {:error, {:unexpected_response, inspect(other)}}
    end

    def normalize_hub_urgency(value) do
      case value |> normalize_atomish() |> String.downcase() do
        "low" -> "low"
        "medium" -> "normal"
        "normal" -> "normal"
        "high" -> "high"
        "urgent" -> "critical"
        "critical" -> "critical"
        _ -> "normal"
      end
    end

    defp normalize_atomish(nil), do: "normal"
    defp normalize_atomish(value) when is_atom(value), do: Atom.to_string(value)
    defp normalize_atomish(value), do: to_string(value)

    defp backpressure_body?(body) do
      provider_backpressure?(body) or
        Map.get(body, "limiterBackpressure") == true or
        limiter_code?(error_code(body)) or
        central_no_direct_fallback_code?(error_code(body))
    end

    defp provider_backpressure?(%{"providerBackpressure" => value}) when is_map(value), do: true
    defp provider_backpressure?(%{"providerBackpressure" => true}), do: true
    defp provider_backpressure?(_body), do: false

    defp limiter_code?(code) do
      normalized = code |> to_string() |> String.downcase()

      String.starts_with?(normalized, "shared_limiter_") or
        normalized in ["queue_full", "queue_timeout", "admission_rejected"]
    end

    defp central_no_direct_fallback_code?(code) do
      normalized = code |> to_string() |> String.downcase()

      Enum.any?(
        [
          "budget_exceeded",
          "cycle_budget_exceeded",
          "job_enqueue_failed",
          "token_budget_exceeded"
        ],
        &(normalized == &1 or String.starts_with?(normalized, "#{&1}:"))
      )
    end

    defp error_code(%{"providerBackpressure" => %{"kind" => kind}}), do: to_string(kind)
    defp error_code(%{"error" => %{"code" => code}}), do: to_string(code)
    defp error_code(%{"code" => code}), do: to_string(code)
    defp error_code(%{"error" => error}) when is_binary(error), do: error
    defp error_code(%{"reason" => reason}) when is_binary(reason), do: reason
    defp error_code(_body), do: "hub_call_failed"

    defp retry_after_ms(body, header) do
      case Map.get(body, "retryAfterMs") || provider_retry_after_ms(body) do
        value when is_integer(value) and value > 0 -> value
        value when is_float(value) and value > 0 -> round(value)
        _ -> retry_after_header_ms(header)
      end
    end

    defp provider_retry_after_ms(%{"providerBackpressure" => %{"retryAfterMs" => value}}),
      do: value

    defp provider_retry_after_ms(_body), do: nil

    defp retry_after_header_ms(value) when is_binary(value) do
      case Float.parse(String.trim(value)) do
        {seconds, ""} when seconds >= 0 -> round(seconds * 1_000)
        _ -> 0
      end
    end

    defp retry_after_header_ms(_value), do: 0

    defp response_retry_after(%{headers: headers}) when is_map(headers) do
      case Map.get(headers, "retry-after") || Map.get(headers, "Retry-After") do
        [value | _] -> value
        value when is_binary(value) -> value
        _ -> nil
      end
    end

    defp response_retry_after(_response), do: nil

    defp hub_base, do: System.get_env("HUB_BASE_URL") || @hub_base_default
    defp hub_token, do: System.get_env("HUB_AUTH_TOKEN") || ""
  end
end
