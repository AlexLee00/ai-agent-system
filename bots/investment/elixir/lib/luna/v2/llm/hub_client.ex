defmodule Luna.V2.LLM.HubClient do
  @moduledoc """
  Hub /hub/llm/* 엔드포인트 호출 전용 HTTP 클라이언트.

  LUNA_LLM_HUB_ROUTING_ENABLED=true 일 때만 실제 호출.
  Hub 응답: { ok, provider, result, durationMs, totalCostUsd, primaryError, ... }
  """

  require Logger

  @hub_base_default "http://localhost:7788"
  @timeout 65_000

  @doc "LUNA_LLM_HUB_ROUTING_ENABLED=true 여부"
  def enabled? do
    System.get_env("LUNA_LLM_HUB_ROUTING_ENABLED") == "true"
  end

  @doc "LUNA_LLM_HUB_ROUTING_SHADOW=true 여부"
  def shadow? do
    System.get_env("LUNA_LLM_HUB_ROUTING_SHADOW") == "true"
  end

  @doc """
  Hub /hub/llm/call 호출.

  request 필드:
    :prompt          — 문자열 (필수)
    :abstract_model  — :anthropic_haiku | :anthropic_sonnet | :anthropic_opus
    :system_prompt   — 선택
    :timeout_ms      — 선택 (기본 60_000)
    :agent           — 에이전트 이름 (로깅용)
    :urgency         — :high | :medium | :low
    :task_type       — atom

  반환: {:ok, %{result, provider, cost_usd, latency_ms}} | {:error, reason}
  """
  def call(request) when is_map(request) do
    url = "#{hub_base()}/hub/llm/call"

    body = %{
      "prompt"        => request[:prompt],
      "abstractModel" => to_string(request[:abstract_model] || :anthropic_haiku),
      "timeoutMs"     => request[:timeout_ms] || 60_000,
      "agent"         => request[:agent] && to_string(request[:agent]),
      "callerTeam"    => "luna",
      "urgency"       => to_string(request[:urgency] || :medium),
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

  # -------------------------------------------------------------------
  # Private
  # -------------------------------------------------------------------

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

  defp hub_base do
    System.get_env("HUB_BASE_URL") || @hub_base_default
  end

  defp hub_token do
    System.get_env("HUB_AUTH_TOKEN") || ""
  end
end
