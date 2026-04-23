defmodule Luna.V2.PositionWatch do
  @moduledoc """
  실시간 포지션 watcher 골격.

  목적:
    - investment.live_positions 를 주기적으로 조회
    - 손실/익절/정체(stale) 포지션을 빠르게 감지
    - Phoenix.PubSub 로 attention 이벤트를 브로드캐스트

  현재는 read-only 감시 레일이며, 실제 청산/조정 실행은 기존 Node 실행 레일이 맡는다.
  """

  use GenServer
  require Logger

  alias Luna.V2.KillSwitch

  @topic "luna:position_watch"

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def run_once do
    GenServer.call(__MODULE__, :run_once, 60_000)
  end

  def init(_opts) do
    interval_ms = KillSwitch.position_watch_interval_ms()
    Logger.info("[루나V2/PositionWatch] 시작 (#{interval_ms}ms 간격)")
    schedule(interval_ms)
    {:ok, %{last_snapshot: nil, last_run: nil}}
  end

  def handle_info(:tick, state) do
    snapshot = build_snapshot()
    maybe_broadcast(snapshot, state.last_snapshot)
    schedule(KillSwitch.position_watch_interval_ms())
    {:noreply, %{state | last_snapshot: snapshot, last_run: DateTime.utc_now()}}
  end

  def handle_call(:run_once, _from, state) do
    snapshot = build_snapshot()
    maybe_broadcast(snapshot, state.last_snapshot)
    {:reply, {:ok, snapshot}, %{state | last_snapshot: snapshot, last_run: DateTime.utc_now()}}
  end

  defp build_snapshot do
    stop_loss_pct = KillSwitch.position_watch_stop_loss_pct()
    adjust_gain_pct = KillSwitch.position_watch_adjust_gain_pct()
    stale_minutes = KillSwitch.position_watch_stale_minutes()

    query = """
    SELECT
      exchange,
      symbol,
      COALESCE(trade_mode, 'normal') AS trade_mode,
      COALESCE(size, 0) AS size,
      COALESCE(entry_price, 0) AS entry_price,
      COALESCE(unrealized_pnl, 0) AS unrealized_pnl,
      updated_at,
      CASE
        WHEN COALESCE(size, 0) * COALESCE(entry_price, 0) > 0
        THEN COALESCE(unrealized_pnl, 0) / (COALESCE(size, 0) * COALESCE(entry_price, 0))
        ELSE NULL
      END AS pnl_ratio
    FROM investment.live_positions
    WHERE status = 'open'
    ORDER BY updated_at DESC NULLS LAST
    LIMIT 200
    """

    case Jay.Core.Repo.query(query, []) do
      {:ok, %{rows: rows, columns: columns}} ->
        positions =
          Enum.map(rows, fn row ->
            row
            |> Enum.zip(columns)
            |> Map.new(fn {value, key} -> {String.to_atom(key), value} end)
          end)

        attention =
          positions
          |> Enum.map(&classify_position(&1, stop_loss_pct, adjust_gain_pct, stale_minutes))
          |> Enum.reject(&is_nil/1)

        %{
          captured_at: DateTime.utc_now(),
          position_count: length(positions),
          attention_count: length(attention),
          stop_loss_pct: stop_loss_pct,
          adjust_gain_pct: adjust_gain_pct,
          stale_minutes: stale_minutes,
          attention: Enum.take(attention, 20)
        }

      {:error, reason} ->
        Logger.warning("[루나V2/PositionWatch] snapshot 실패: #{inspect(reason)}")

        %{
          captured_at: DateTime.utc_now(),
          error: inspect(reason),
          position_count: 0,
          attention_count: 0,
          attention: []
        }
    end
  end

  defp classify_position(position, stop_loss_pct, adjust_gain_pct, stale_minutes) do
    pnl_ratio = to_float(position[:pnl_ratio])
    stale? = stale_position?(position[:updated_at], stale_minutes)

    cond do
      stale? ->
        Map.merge(position, %{attention_type: :stale_position, reason: "updated_at stale"})

      pnl_ratio <= -abs(stop_loss_pct) ->
        Map.merge(position, %{attention_type: :stop_loss_attention, reason: "loss threshold hit"})

      pnl_ratio >= abs(adjust_gain_pct) ->
        Map.merge(position, %{attention_type: :partial_adjust_attention, reason: "gain threshold hit"})

      true ->
        nil
    end
  end

  defp stale_position?(nil, _stale_minutes), do: false

  defp stale_position?(%NaiveDateTime{} = dt, stale_minutes) do
    NaiveDateTime.diff(NaiveDateTime.utc_now(), dt, :minute) >= stale_minutes
  end

  defp stale_position?(%DateTime{} = dt, stale_minutes) do
    DateTime.diff(DateTime.utc_now(), dt, :minute) >= stale_minutes
  end

  defp stale_position?(_, _stale_minutes), do: false

  defp maybe_broadcast(snapshot, previous_snapshot) do
    previous_attention = Map.get(previous_snapshot || %{}, :attention_count, 0)
    current_attention = Map.get(snapshot, :attention_count, 0)

    if current_attention > 0 and (previous_attention != current_attention or previous_attention == 0) do
      Logger.warning("[루나V2/PositionWatch] attention #{current_attention}건 감지")

      Phoenix.PubSub.broadcast(
        Luna.V2.PubSub,
        @topic,
        {:position_watch_attention, snapshot}
      )
    end
  end

  defp to_float(nil), do: 0.0
  defp to_float(%Decimal{} = value), do: Decimal.to_float(value)
  defp to_float(value) when is_number(value), do: value * 1.0
  defp to_float(_), do: 0.0

  defp schedule(interval_ms) do
    Process.send_after(self(), :tick, max(5_000, interval_ms))
  end
end
