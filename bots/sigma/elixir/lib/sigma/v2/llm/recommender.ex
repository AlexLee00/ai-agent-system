defmodule Sigma.V2.LLM.Recommender do
  @moduledoc """
  컨텍스트 기반 동적 LLM 모델 추천 엔진 (룰 기반, LLM 미사용 — 재귀 방지).

  Selector의 정적 정책을 런타임 컨텍스트로 오버라이드.

  입력 컨텍스트 키:
    - :prompt_len         — 프롬프트 문자 수 (integer)
    - :budget_remaining_pct — 남은 예산 비율 0.0~1.0 (float)
    - :failure_rate       — 최근 호출 실패율 0.0~1.0 (float)
    - :urgency            — :high | :normal (atom)

  출력: {:ok, %{route: atom, reason: string}}
  """

  @doc """
  agent_name + 컨텍스트 → 추천 route.
  """
  def recommend(agent_name, context \\ %{}) do
    base_policy = Sigma.V2.LLM.Selector.policy_for(agent_name)
    override = determine_override(context)
    recommended_route = override || base_policy.route

    {:ok, %{route: recommended_route, reason: explain(context, override, base_policy.route)}}
  end

  defp determine_override(context) do
    cond do
      budget_critical?(context)  -> :anthropic_haiku   # 예산 부족 → 저렴한 모델 절약
      urgency_high?(context)     -> :anthropic_haiku   # 긴급 → 빠른 응답 우선
      high_failure_rate?(context) -> :anthropic_opus   # 실패율 높음 → 강력한 모델로 품질 강화
      prompt_too_long?(context)  -> :anthropic_sonnet  # 긴 프롬프트 → 컨텍스트 큰 모델
      true                       -> nil                # 기본 정책 유지
    end
  end

  defp budget_critical?(%{budget_remaining_pct: pct}) when is_number(pct), do: pct < 0.2
  defp budget_critical?(_), do: false

  defp urgency_high?(%{urgency: :high}), do: true
  defp urgency_high?(_), do: false

  defp high_failure_rate?(%{failure_rate: rate}) when is_number(rate), do: rate > 0.3
  defp high_failure_rate?(_), do: false

  defp prompt_too_long?(%{prompt_len: len}) when is_integer(len), do: len > 8_000
  defp prompt_too_long?(_), do: false

  defp explain(_ctx, nil, base_route),
    do: "기본 정책 #{base_route} — 컨텍스트 오버라이드 없음"

  defp explain(%{budget_remaining_pct: pct}, :anthropic_haiku, _) when is_number(pct) and pct < 0.2,
    do: "예산 잔여 #{round(pct * 100)}% — haiku 절약 모드"

  defp explain(%{urgency: :high}, :anthropic_haiku, _),
    do: "긴급 요청 — haiku 빠른 응답"

  defp explain(%{failure_rate: rate}, :anthropic_opus, _) when is_number(rate),
    do: "최근 실패율 #{round(rate * 100)}% — opus 품질 강화"

  defp explain(%{prompt_len: len}, :anthropic_sonnet, _) when is_integer(len),
    do: "프롬프트 #{len}자 — sonnet 컨텍스트 확장"

  defp explain(_ctx, override, _), do: "#{override} 추천"
end
