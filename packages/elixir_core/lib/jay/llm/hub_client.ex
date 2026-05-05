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
    team        = Keyword.fetch!(opts, :team)
    routing_env = Keyword.get(opts, :routing_env, "LLM_HUB_ROUTING_ENABLED")
    shadow_env  = Keyword.get(opts, :shadow_env, "LLM_HUB_ROUTING_SHADOW")

    quote do
      require Logger

      @team        unquote(team)
      @routing_env unquote(routing_env)
      @shadow_env  unquote(shadow_env)

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
        "prompt"        => request[:prompt],
        "abstractModel" => to_string(request[:abstract_model] || :anthropic_haiku),
        "timeoutMs"     => request[:timeout_ms] || 60_000,
        "agent"         => request[:agent] && to_string(request[:agent]),
        "callerTeam"    => team,
        "urgency"       => normalize_hub_urgency(request[:urgency]),
        "taskType"      => request[:task_type] && to_string(request[:task_type]),
      }

      body =
        if request[:system_prompt],
          do:   Map.put(body, "systemPrompt", request[:system_prompt]),
          else: body

      headers = [{"Authorization", "Bearer #{hub_token()}"}]

      case Req.post(url, json: body, headers: headers, receive_timeout: @timeout) do
        {:ok, %{status: 200, body: resp}} when is_map(resp) ->
          parse_response(resp)

        {:ok, %{status: 200, body: raw}} when is_binary(raw) ->
          case Jason.decode(raw) do
            {:ok, resp} -> parse_response(resp)
            _           -> {:error, {:json_parse_error, String.slice(raw, 0, 200)}}
          end

        {:ok, %{status: status, body: body}} ->
          {:error, {:hub_http_error, status, inspect(body)}}

        {:error, err} ->
          {:error, {:hub_request_failed, inspect(err)}}
      end
    end

    defp parse_response(%{"ok" => true, "result" => result} = resp) do
      {:ok, %{
        result:         result,
        provider:       Map.get(resp, "provider", "unknown"),
        cost_usd:       Map.get(resp, "totalCostUsd"),
        latency_ms:     Map.get(resp, "durationMs", 0),
        fallback_count: Map.get(resp, "fallbackCount", 0),
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

    defp hub_base, do: System.get_env("HUB_BASE_URL") || @hub_base_default
    defp hub_token, do: System.get_env("HUB_AUTH_TOKEN") || ""
  end
end
