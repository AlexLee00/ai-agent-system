defmodule Luna.V2.Policy.BudgetPolicyEngine do
  @moduledoc """
  예산 할당 정책 엔진.

  일일 예산 한도 관리:
  - validation lane (소액 검증)
  - normal lane (정상 거래)
  - market별 한도 (crypto/domestic/overseas)
  """
  require Logger

  @daily_limits %{
    crypto:   %{validation: 50_000,  normal: 500_000},
    domestic: %{validation: 100_000, normal: 2_000_000},
    overseas: %{validation: 100_000, normal: 1_500_000}
  }

  def allocate(candidate, market, lane \\ :normal) do
    limits = get_in(@daily_limits, [market, lane]) || 100_000
    spent = get_spent_today(market, lane)
    remaining = limits - spent
    amt = candidate[:amount_krw] || 0

    if amt > remaining do
      Logger.warning("[Budget] 일일 예산 초과: market=#{market} lane=#{lane} required=#{amt} remaining=#{remaining}")
      {:error, :daily_budget_exhausted, "잔여 예산 #{remaining} < 요청 #{amt}"}
    else
      {:ok, Map.merge(candidate, %{budget_lane: lane, budget_remaining: remaining})}
    end
  end

  defp get_spent_today(market, lane) do
    query = """
    SELECT COALESCE(SUM(amount_krw), 0)
    FROM investment.order_log
    WHERE DATE(created_at AT TIME ZONE 'Asia/Seoul') = CURRENT_DATE
      AND market = $1
      AND budget_lane = $2
      AND status IN ('filled', 'partial')
    """
    case Jay.Core.Repo.query(query, [to_string(market), to_string(lane)]) do
      {:ok, %{rows: [[val | _] | _]}} -> to_number(val)
      _ -> 0
    end
  end

  defp to_number(nil), do: 0
  defp to_number(d) when is_struct(d, Decimal), do: Decimal.to_integer(d)
  defp to_number(n) when is_number(n), do: round(n)
  defp to_number(_), do: 0
end
