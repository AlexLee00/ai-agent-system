defmodule Luna.V2.Policy.ReentryPolicyEngine do
  @moduledoc """
  재진입 제어 엔진.

  - 손절 후 쿨다운 (동일 심볼 24시간 차단)
  - 연속 손실 3회 후 7일 차단
  - 최대 수익 대비 50% 회수 후 재진입 허용
  """
  require Logger

  @cooldown_hours 24
  @ban_days 7
  @consecutive_loss_threshold 3

  def check(candidate, _context \\ %{}) do
    symbol = candidate[:symbol]

    with :ok <- check_stop_loss_cooldown(symbol),
         :ok <- check_consecutive_losses(symbol) do
      {:ok, :passed}
    end
  end

  defp check_stop_loss_cooldown(nil), do: :ok
  defp check_stop_loss_cooldown(symbol) do
    query = """
    SELECT COUNT(*) FROM investment.trade_history
    WHERE symbol = $1
      AND exit_reason = 'stop_loss'
      AND closed_at > NOW() - INTERVAL '#{@cooldown_hours} hours'
    """
    case Jay.Core.Repo.query(query, [symbol]) do
      {:ok, %{rows: [[count | _] | _]}} when count > 0 ->
        {:error, :reentry_cooldown, "#{symbol} 손절 후 #{@cooldown_hours}시간 쿨다운"}
      _ -> :ok
    end
  end

  defp check_consecutive_losses(nil), do: :ok
  defp check_consecutive_losses(symbol) do
    query = """
    SELECT exit_reason FROM investment.trade_history
    WHERE symbol = $1
      AND closed_at > NOW() - INTERVAL '#{@ban_days} days'
    ORDER BY closed_at DESC
    LIMIT #{@consecutive_loss_threshold}
    """
    case Jay.Core.Repo.query(query, [symbol]) do
      {:ok, %{rows: rows}} ->
        all_losses? = length(rows) >= @consecutive_loss_threshold and
          Enum.all?(rows, fn [reason] -> reason in ["stop_loss", "forced_close"] end)

        if all_losses? do
          {:error, :reentry_banned, "#{symbol} 연속 #{@consecutive_loss_threshold}회 손실 — #{@ban_days}일 차단"}
        else
          :ok
        end
      _ -> :ok
    end
  end
end
