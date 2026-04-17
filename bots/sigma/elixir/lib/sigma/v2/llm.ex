defmodule Sigma.V2.LLM do
  @moduledoc """
  Phase 3 하위호환 래퍼 — Sigma.V2.LLM.Selector 위임.
  신규 코드는 Selector.call_with_fallback/3 직접 호출 권장.
  참조: bots/sigma/docs/PLAN.md §6 Phase 3 (LUNA_ALIGN 수정)
  """

  @doc "LLM 완성 호출. model/budget_tracker → agent 정책 키 변환."
  def complete(prompt, opts \\ []) do
    agent = resolve_agent(opts[:budget_tracker] || opts[:model] || :default)
    Sigma.V2.LLM.Selector.call_with_fallback(agent, prompt, opts)
  end

  # ---

  defp resolve_agent(:fast),               do: :"skill.feature_planner"
  defp resolve_agent(:smart),              do: :commander
  defp resolve_agent(:haiku),              do: :"pod.growth"
  defp resolve_agent("sigma_reflexion"),   do: :reflexion
  defp resolve_agent("sigma_espl_evolve"), do: :espl
  defp resolve_agent(_),                   do: :"pod.growth"
end
