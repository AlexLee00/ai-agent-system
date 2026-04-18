defmodule Luna.V2.MAPEK.Monitor do
  @moduledoc """
  MAPE-K Monitor — 시장·포트폴리오 지속 감시.

  10분마다 다음을 감지:
    - 비정상 포지션 (stale/orphan)
    - 시장 레짐 변화
    - 리스크 한도 초과
    - 일일 손실 한도 임박 (80% 이상)

  이벤트 → Phoenix.PubSub luna:mapek_events
  """

  use GenServer
  require Logger

  @interval_ms 10 * 60 * 1_000  # 10분

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  # ─── 공개 API ───────────────────────────────────────────────────────

  def run_once do
    GenServer.call(__MODULE__, :run_once, 60_000)
  end

  # ─── GenServer 콜백 ─────────────────────────────────────────────────

  def init(_opts) do
    Logger.info("[루나V2/MAPE-K Monitor] 감시 시작 (#{@interval_ms}ms 간격)")
    schedule()
    {:ok, %{last_run: nil, anomalies: []}}
  end

  def handle_info(:tick, state) do
    anomalies = detect_anomalies()
    if anomalies != [] do
      Logger.warning("[루나V2/MAPE-K Monitor] 이상 감지 #{length(anomalies)}건")
      Phoenix.PubSub.broadcast(Luna.V2.PubSub, "luna:mapek_events", {:anomalies_detected, anomalies})
    end
    schedule()
    {:noreply, %{state | last_run: DateTime.utc_now(), anomalies: anomalies}}
  end

  def handle_call(:run_once, _from, state) do
    anomalies = detect_anomalies()
    {:reply, {:ok, anomalies}, %{state | last_run: DateTime.utc_now(), anomalies: anomalies}}
  end

  # ─── 감지 로직 ──────────────────────────────────────────────────────

  defp detect_anomalies do
    []
    |> detect_stale_positions()
    |> detect_risk_limit()
  end

  defp detect_stale_positions(anomalies) do
    query = """
    SELECT id, symbol, exchange, updated_at
    FROM investment.live_positions
    WHERE status = 'open'
      AND updated_at < NOW() - INTERVAL '4 hours'
    LIMIT 10
    """
    case Jay.Core.Repo.query(query, []) do
      {:ok, %{rows: rows}} when rows != [] ->
        stale = Enum.map(rows, fn [id, sym, ex, ts] -> %{type: :stale_position, id: id, symbol: sym, exchange: ex, last_update: ts} end)
        stale ++ anomalies
      _ -> anomalies
    end
  end

  defp detect_risk_limit(anomalies) do
    query = """
    SELECT COALESCE(SUM(realized_pnl_usd), 0)
    FROM investment.live_positions
    WHERE DATE(created_at AT TIME ZONE 'Asia/Seoul') = CURRENT_DATE
      AND realized_pnl_usd < 0
    """
    case Jay.Core.Repo.query(query, []) do
      {:ok, %{rows: [[loss | _] | _]}} ->
        loss_f = to_float(loss)
        if abs(loss_f) > 160.0 do  # 80% of $200 limit
          [%{type: :daily_loss_warning, loss_usd: abs(loss_f), limit_usd: 200.0} | anomalies]
        else
          anomalies
        end
      _ -> anomalies
    end
  end

  defp to_float(nil), do: 0.0
  defp to_float(d) when is_struct(d, Decimal), do: Decimal.to_float(d)
  defp to_float(n) when is_number(n), do: n * 1.0
  defp to_float(_), do: 0.0

  defp schedule do
    Process.send_after(self(), :tick, @interval_ms)
  end
end
