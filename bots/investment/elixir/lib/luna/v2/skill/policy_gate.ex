defmodule Luna.V2.Skill.PolicyGate do
  @moduledoc """
  5개 정책 엔진 통과 게이트.

  HardRule → AdaptiveRisk → Budget → Reentry → Exposure 순서 적용.
  하나라도 거부되면 해당 후보 제외.
  """
  use Jido.Action,
    name:        "policy_gate",
    description: "5개 정책 엔진 통과 필터",
    schema: [
      candidates: [type: {:list, :map}, required: true],
      market:     [type: :atom, required: true]
    ]

  require Logger

  alias Luna.V2.Policy.{
    HardRuleEngine,
    AdaptiveRiskEngine,
    BudgetPolicyEngine,
    ReentryPolicyEngine,
    ExposurePolicyEngine
  }

  @impl true
  def run(%{candidates: candidates, market: market}, _context) do
    market_context = fetch_market_context(market)
    portfolio_state = fetch_portfolio_state()

    {approved, rejected} =
      Enum.reduce(candidates, {[], []}, fn candidate, {ok, rej} ->
        case apply_policies(candidate, market, market_context, portfolio_state) do
          {:ok, adjusted} ->
            {[adjusted | ok], rej}
          {:error, code, reason} ->
            Logger.info("[PolicyGate] 거부 #{candidate[:symbol]} — #{code}: #{reason}")
            {ok, [{candidate, code, reason} | rej]}
        end
      end)

    Logger.info("[PolicyGate] 승인 #{length(approved)}건 / 거부 #{length(rejected)}건")
    {:ok, %{approved: Enum.reverse(approved), rejected: Enum.reverse(rejected), market: market}}
  end

  defp apply_policies(candidate, market, market_context, portfolio_state) do
    with {:ok, :passed}  <- HardRuleEngine.check(candidate, market_context),
         {:ok, adjusted} <- AdaptiveRiskEngine.adjust(candidate, market_context),
         {:ok, budgeted}  <- BudgetPolicyEngine.allocate(adjusted, market),
         {:ok, :passed}  <- ReentryPolicyEngine.check(budgeted),
         {:ok, :passed}  <- ExposurePolicyEngine.check(budgeted, portfolio_state) do
      {:ok, budgeted}
    end
  end

  defp fetch_market_context(market) do
    # VIX/공포탐욕 등 시장 컨텍스트 조회 (DB 캐시)
    query = """
    SELECT vix, fear_and_greed, volatility_1d
    FROM investment.market_regime_snapshots
    WHERE market = $1
    ORDER BY captured_at DESC LIMIT 1
    """
    case Jay.Core.Repo.query(query, [to_string(market)]) do
      {:ok, %{rows: [[vix, fng, vol | _] | _]}} ->
        %{vix: to_f(vix), fear_and_greed: to_f(fng), volatility_1d: to_f(vol)}
      _ ->
        %{vix: 20.0, fear_and_greed: 50, volatility_1d: 0.03}
    end
  end

  defp fetch_portfolio_state do
    query = """
    SELECT COALESCE(SUM(current_value_krw), 0) as total
    FROM investment.live_positions WHERE status = 'open'
    """
    total = case Jay.Core.Repo.query(query, []) do
      {:ok, %{rows: [[v | _] | _]}} -> to_f(v)
      _ -> 10_000_000.0
    end
    %{total_value_krw: total}
  end

  defp to_f(nil), do: 0.0
  defp to_f(d) when is_struct(d, Decimal), do: Decimal.to_float(d)
  defp to_f(n) when is_number(n), do: n * 1.0
  defp to_f(_), do: 0.0
end
