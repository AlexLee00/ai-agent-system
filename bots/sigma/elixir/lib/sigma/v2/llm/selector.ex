defmodule Sigma.V2.LLM.Selector do
  @moduledoc """
  시그마 LLM Selector — 공용 레이어 위임.

  Jay.Core.LLM.Selector를 사용하며 Sigma.V2.LLM.Policy로 팀 정책 주입.
  공개 API:
    call_with_fallback/3 — (agent, prompt, opts) → {:ok, %{response:, ...}} | {:error, reason}
    policy_for/1         — 에이전트 정적 정책 조회
  """

  use Jay.Core.LLM.Selector, policy_module: Sigma.V2.LLM.Policy

  @doc """
  시그마 레거시 반환 형식 유지.
  반환: {:ok, %{response:, model:, provider:, tokens:, latency_ms:}} | {:error, reason}
  """
  def call_with_fallback(agent_name, prompt, opts) when is_binary(prompt) do
    case complete(agent_name, [%{role: "user", content: prompt}], opts) do
      {:ok, content} ->
        policy = policy_for(agent_name)
        {:ok, %{
          response:   content,
          model:      to_string(policy.route),
          provider:   "hub_or_direct",
          tokens:     %{in: 0, out: 0},
          latency_ms: 0
        }}

      error ->
        error
    end
  end
end
