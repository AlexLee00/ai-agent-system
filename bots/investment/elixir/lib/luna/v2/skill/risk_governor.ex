defmodule Luna.V2.Skill.RiskGovernor do
  @moduledoc "실시간 리스크 한도 점검 — Nemesis L20 Hard Rule 미러 (Elixir 레이어)"
  use Jido.Action,
    name: "risk_governor",
    description: "현재 포지션 규모·손실 한도·집중도 위반 여부를 점검합니다.",
    schema: [
      symbol:   [type: :string, required: false, doc: "특정 심볼 점검 (없으면 전체)"],
      exchange: [type: :string, required: false, doc: "거래소 필터"]
    ]

  require Logger

  # 하드코딩 한도 (config.yaml 값과 동기화 필요 — 추후 runtime-config 연동)
  @max_single_position_pct 0.20   # 단일 포지션 최대 20% NAV
  @daily_loss_limit_usd    200.0  # 일일 손실 한도 $200

  def run(%{symbol: symbol, exchange: exchange}, _context) do
    Logger.info("[루나V2/RiskGovernor] 리스크 점검 symbol=#{symbol} exchange=#{exchange}")

    violations = []
      |> check_position_concentration(symbol, exchange)
      |> check_total_exposure()
      |> check_daily_loss()

    status = if violations == [], do: :ok, else: :violation
    {:ok, %{status: status, violations: violations, checked_at: DateTime.utc_now()}}
  end

  defp check_position_concentration(violations, symbol, exchange) do
    query = """
    SELECT symbol, exchange, ABS(size * entry_price) AS notional_usd
    FROM investment.live_positions
    WHERE status = 'open'
    #{if symbol, do: "AND symbol = '#{symbol}'", else: ""}
    #{if exchange, do: "AND exchange = '#{exchange}'", else: ""}
    ORDER BY notional_usd DESC
    LIMIT 10
    """
    case Jay.Core.Repo.query(query, []) do
      {:ok, %{rows: rows}} ->
        oversized = Enum.filter(rows, fn [_, _, notional] ->
          notional && Decimal.compare(notional, @max_single_position_pct * 10_000) == :gt
        end)
        if oversized != [] do
          [{:concentration_exceeded, Enum.map(oversized, fn [sym, ex, n] -> "#{ex}/#{sym} $#{n}" end)} | violations]
        else
          violations
        end
      _ -> violations
    end
  end

  defp check_total_exposure(violations) do
    violations  # TODO: NAV 대비 전체 노출 계산
  end

  defp check_daily_loss(violations) do
    query = """
    SELECT COALESCE(SUM(realized_pnl_usd), 0)
    FROM investment.live_positions
    WHERE DATE(created_at AT TIME ZONE 'Asia/Seoul') = CURRENT_DATE
      AND realized_pnl_usd < 0
    """
    case Jay.Core.Repo.query(query, []) do
      {:ok, %{rows: [[loss | _] | _]}} when not is_nil(loss) ->
        loss_f = if is_struct(loss, Decimal), do: Decimal.to_float(loss), else: loss
        if abs(loss_f) > @daily_loss_limit_usd do
          [{:daily_loss_exceeded, "일일 손실 $#{abs(loss_f)} > 한도 $#{@daily_loss_limit_usd}"} | violations]
        else
          violations
        end
      _ -> violations
    end
  end
end
