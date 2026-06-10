defmodule Darwin.V2.LLM.Selector do
  @moduledoc """
  다윈 LLM Selector — 공용 레이어 위임.

  Jay.Core.LLM.Selector를 사용하며 Darwin.V2.LLM.Policy로 팀 정책 주입.
  Kill switch: Darwin.V2.Config.kill_switch?() (Policy 콜백 경유).

  공개 API:
    complete/3           — (agent_name, messages, opts) → {:ok, content} | {:error, reason}
    call_with_fallback/3 — 구버전 호환 래퍼
    policy_for/1         — 에이전트 정적 정책 조회
  """

  use Jay.Core.LLM.Selector, policy_module: Darwin.V2.LLM.Policy

  @doc """
  Darwin V2 레거시 스킬들은 `{:ok, %{response: text}}` 형태를 매칭한다.

  공용 Jay.Core selector는 현재 `{:ok, content_string}`을 반환하므로 Darwin
  경계에서만 레거시 shape로 정규화해 기존 스킬들의 case-clause crash를 막는다.
  """
  def call_with_fallback(agent_name, prompt, opts) when is_binary(prompt) do
    agent_name
    |> complete([%{role: "user", content: prompt}], opts)
    |> normalize_legacy_response()
  end

  @doc false
  def normalize_legacy_response({:ok, %{response: text} = response}) when is_binary(text), do: {:ok, response}

  def normalize_legacy_response({:ok, %{"response" => text} = response}) when is_binary(text) do
    {:ok, Map.put(response, :response, text)}
  end

  def normalize_legacy_response({:ok, %{content: text} = response}) when is_binary(text) do
    {:ok, Map.put(response, :response, text)}
  end

  def normalize_legacy_response({:ok, %{"content" => text} = response}) when is_binary(text) do
    {:ok, Map.put(response, :response, text)}
  end

  def normalize_legacy_response({:ok, text}) when is_binary(text), do: {:ok, %{response: text}}
  def normalize_legacy_response(other), do: other
end
