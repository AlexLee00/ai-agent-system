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

  alias Luna.V2.{KillSwitch, MarketHoursGate}

  @topic "luna:position_watch"

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def run_once do
    GenServer.call(__MODULE__, :run_once, 60_000)
  end

  def set_dynamic_interval(interval_ms, source \\ "luna", ttl_ms \\ 600_000)
      when is_integer(interval_ms) and interval_ms > 0 and is_integer(ttl_ms) and ttl_ms > 0 do
    GenServer.cast(__MODULE__, {:set_dynamic_interval, interval_ms, source, ttl_ms})
  end

  def clear_dynamic_interval do
    GenServer.cast(__MODULE__, :clear_dynamic_interval)
  end

  def init(_opts) do
    interval_ms = KillSwitch.position_watch_interval_ms()
    Logger.info("[루나V2/PositionWatch] 시작 (#{interval_ms}ms 간격)")
    schedule(interval_ms)

    {:ok,
     %{
       last_snapshot: nil,
       last_run: nil,
       last_interval_ms: interval_ms,
       dynamic_interval_ms: nil,
       dynamic_interval_until: nil,
       dynamic_interval_source: nil,
       active_backtest_cooldowns: %{},
       strategy_exit_cooldowns: %{}
     }}
  end

  def handle_info(:tick, state) do
    snapshot = build_snapshot()
    maybe_broadcast(snapshot, state.last_snapshot)
    state = maybe_trigger_active_backtests(snapshot, state)
    state = maybe_trigger_strategy_exit_previews(snapshot, state)
    next_interval_ms = effective_interval_ms(snapshot, state)
    schedule(next_interval_ms)

    {:noreply,
     %{
       state
       | last_snapshot: snapshot,
         last_run: DateTime.utc_now(),
         last_interval_ms: next_interval_ms
     }}
  end

  def handle_call(:run_once, _from, state) do
    snapshot = build_snapshot()
    maybe_broadcast(snapshot, state.last_snapshot)
    state = maybe_trigger_active_backtests(snapshot, state)
    state = maybe_trigger_strategy_exit_previews(snapshot, state)
    {:reply, {:ok, snapshot}, %{state | last_snapshot: snapshot, last_run: DateTime.utc_now()}}
  end

  def handle_cast({:set_dynamic_interval, interval_ms, source, ttl_ms}, state) do
    until_at = DateTime.add(DateTime.utc_now(), ttl_ms, :millisecond)

    Logger.info(
      "[루나V2/PositionWatch] 동적 감시 간격 적용 #{interval_ms}ms source=#{source} ttl_ms=#{ttl_ms}"
    )

    {:noreply,
     %{
       state
       | dynamic_interval_ms: interval_ms,
         dynamic_interval_until: until_at,
         dynamic_interval_source: source
     }}
  end

  def handle_cast(:clear_dynamic_interval, state) do
    Logger.info("[루나V2/PositionWatch] 동적 감시 간격 해제")

    {:noreply,
     %{
       state
       | dynamic_interval_ms: nil,
         dynamic_interval_until: nil,
         dynamic_interval_source: nil
     }}
  end

  defp build_snapshot do
    stop_loss_pct = KillSwitch.position_watch_stop_loss_pct()
    adjust_gain_pct = KillSwitch.position_watch_adjust_gain_pct()
    stale_minutes = KillSwitch.position_watch_stale_minutes()
    crypto_dust_usdt = KillSwitch.position_watch_crypto_dust_usdt()
    tv_enabled? = KillSwitch.position_watch_tv_enabled?()
    tv_timeframes = KillSwitch.position_watch_tv_timeframes()
    tv_stale_ms = KillSwitch.position_watch_tv_stale_ms()

    query = """
    SELECT
      exchange,
      symbol,
      COALESCE(trade_mode, 'normal') AS trade_mode,
      COALESCE(size, 0) AS size,
      COALESCE(entry_price, 0) AS entry_price,
      COALESCE(unrealized_pnl, 0) AS unrealized_pnl,
      COALESCE(size, 0) * COALESCE(entry_price, 0) AS notional_value,
      updated_at,
      psp.strategy_name,
      psp.setup_type,
      psp.monitoring_plan,
      psp.exit_plan,
      psp.backtest_plan,
      bt.created_at AS backtest_created_at,
      bt.label AS backtest_label,
      bt.sharpe AS backtest_sharpe,
      bt.total_return AS backtest_total_return,
      bt.max_drawdown AS backtest_max_drawdown,
      bt.total_trades AS backtest_total_trades,
      CASE
        WHEN COALESCE(size, 0) * COALESCE(entry_price, 0) > 0
        THEN COALESCE(unrealized_pnl, 0) / (COALESCE(size, 0) * COALESCE(entry_price, 0))
        ELSE NULL
      END AS pnl_ratio
    FROM investment.live_positions
    LEFT JOIN LATERAL (
      SELECT strategy_name, setup_type, monitoring_plan, exit_plan, backtest_plan
      FROM investment.position_strategy_profiles psp
      WHERE psp.symbol = investment.live_positions.symbol
        AND psp.exchange = investment.live_positions.exchange
        AND COALESCE(psp.trade_mode, 'normal') = COALESCE(investment.live_positions.trade_mode, 'normal')
        AND psp.status = 'active'
      ORDER BY psp.updated_at DESC
      LIMIT 1
    ) psp ON TRUE
    LEFT JOIN LATERAL (
      SELECT created_at, label, sharpe, total_return, max_drawdown, total_trades
      FROM vectorbt_backtest_runs bt
      WHERE bt.symbol = investment.live_positions.symbol
        AND bt.created_at > now() - INTERVAL '180 days'
      ORDER BY bt.created_at DESC
      LIMIT 1
    ) bt ON TRUE
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

        tv_snapshot =
          fetch_tradingview_snapshot(positions, tv_enabled?, tv_timeframes, tv_stale_ms)

          positions_with_tv = attach_tv_snapshot(positions, tv_snapshot)

        {dust_positions, active_positions} =
          Enum.split_with(positions_with_tv, &dust_position?(&1, crypto_dust_usdt))

        attention =
          active_positions
          |> Enum.map(
            &classify_position(&1, stop_loss_pct, adjust_gain_pct, stale_minutes, tv_stale_ms)
          )
          |> Enum.reject(&is_nil/1)

        %{
          captured_at: DateTime.utc_now(),
          position_count: length(active_positions),
          ignored_dust_count: length(dust_positions),
          attention_count: length(attention),
          watch_context: build_watch_context(active_positions, tv_snapshot),
          stop_loss_pct: stop_loss_pct,
          adjust_gain_pct: adjust_gain_pct,
          stale_minutes: stale_minutes,
          tv_watch: %{
            enabled: tv_enabled?,
            timeframes: tv_timeframes,
            stale_ms: tv_stale_ms,
            status: Map.get(tv_snapshot, :status, :disabled),
            count: map_size(Map.get(tv_snapshot, :bars, %{})),
            error: Map.get(tv_snapshot, :error)
          },
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

  defp classify_position(position, stop_loss_pct, adjust_gain_pct, stale_minutes, tv_stale_ms) do
    pnl_ratio = to_float(position[:pnl_ratio])
    stale? = stale_position?(position[:updated_at], stale_minutes)
    tv_attention = classify_tv_attention(position[:tv], tv_stale_ms)
    setup_type = normalize_setup_type(position[:setup_type])
    monitoring_plan = normalize_json_map(position[:monitoring_plan])
    backtest_plan = normalize_json_map(position[:backtest_plan])
    adjusted_gain_pct = strategy_adjust_gain_pct(adjust_gain_pct, setup_type)
    adjusted_stop_loss_pct = strategy_stop_loss_pct(stop_loss_pct, setup_type)
    strategy_tv_attention =
      classify_strategy_tv_attention(position, setup_type, monitoring_plan, adjusted_gain_pct)
    backtest_attention = classify_backtest_drift_attention(position, backtest_plan)

    cond do
      not is_nil(strategy_tv_attention) ->
        Map.merge(position, strategy_tv_attention)

      not is_nil(backtest_attention) ->
        Map.merge(position, backtest_attention)

      not is_nil(tv_attention) ->
        Map.merge(position, tv_attention)

      stale? ->
        Map.merge(position, %{attention_type: :stale_position, reason: "updated_at stale"})

      pnl_ratio <= -abs(adjusted_stop_loss_pct) ->
        Map.merge(position, %{attention_type: :stop_loss_attention, reason: "loss threshold hit"})

      pnl_ratio >= abs(adjusted_gain_pct) ->
        Map.merge(position, %{
          attention_type: :partial_adjust_attention,
          reason: "gain threshold hit"
        })

      true ->
        nil
    end
  end

  defp dust_position?(position, crypto_dust_usdt) do
    market_from_exchange(position[:exchange]) == :crypto and
      to_float(position[:notional_value]) > 0 and
      to_float(position[:notional_value]) < crypto_dust_usdt
  end

  defp stale_position?(nil, _stale_minutes), do: false

  defp stale_position?(%NaiveDateTime{} = dt, stale_minutes) do
    NaiveDateTime.diff(NaiveDateTime.utc_now(), dt, :minute) >= stale_minutes
  end

  defp stale_position?(%DateTime{} = dt, stale_minutes) do
    DateTime.diff(DateTime.utc_now(), dt, :minute) >= stale_minutes
  end

  defp stale_position?(_, _stale_minutes), do: false

  defp build_watch_context(positions, tv_snapshot) do
    counts =
      Enum.reduce(positions, %{crypto: 0, domestic: 0, overseas: 0, unknown: 0}, fn position,
                                                                                    acc ->
        market = market_from_exchange(position[:exchange])
        Map.update(acc, market, 1, &(&1 + 1))
      end)

    domestic_open? = MarketHoursGate.open?(:domestic)
    overseas_open? = MarketHoursGate.open?(:overseas)
    tv_status = Map.get(tv_snapshot, :status, :disabled)

    recommended_interval_ms =
      cond do
        counts.crypto > 0 and tv_status in [:http_error, :transport_error, :disconnected] ->
          KillSwitch.position_watch_fallback_ms()

        counts.crypto > 0 ->
          KillSwitch.position_watch_crypto_realtime_ms()

        (counts.domestic > 0 and domestic_open?) or (counts.overseas > 0 and overseas_open?) ->
          KillSwitch.position_watch_stock_realtime_ms()

        counts.domestic > 0 or counts.overseas > 0 ->
          KillSwitch.position_watch_stock_offhours_ms()

        true ->
          KillSwitch.position_watch_idle_ms()
      end

    recommended_mode =
      cond do
        counts.crypto > 0 ->
          :crypto_realtime

        (counts.domestic > 0 and domestic_open?) or (counts.overseas > 0 and overseas_open?) ->
          :stocks_realtime

        counts.domestic > 0 or counts.overseas > 0 ->
          :stocks_offhours

        true ->
          :idle
      end

    %{
      market_mix: counts,
      domestic_open?: domestic_open?,
      overseas_open?: overseas_open?,
      tv_status: tv_status,
      recommended_mode: recommended_mode,
      recommended_interval_ms: recommended_interval_ms
    }
  end

  defp fetch_tradingview_snapshot(_positions, false, _timeframes, _tv_stale_ms) do
    %{status: :disabled, bars: %{}, error: nil}
  end

  defp fetch_tradingview_snapshot(positions, true, timeframes, _tv_stale_ms) do
    symbols =
      positions
      |> Enum.map(&to_tv_symbol/1)
      |> Enum.reject(&is_nil/1)
      |> Enum.uniq()

    Enum.each(symbols, fn symbol ->
      Enum.each(timeframes, fn timeframe ->
        _ =
          Req.get("#{KillSwitch.position_watch_tv_base_url()}/subscribe",
            params: [symbol: symbol, timeframe: timeframe],
            retry: false
          )
      end)
    end)

    case Req.get("#{KillSwitch.position_watch_tv_base_url()}/latest",
           params: [symbols: Enum.join(symbols, ","), timeframes: Enum.join(timeframes, ",")],
           retry: false
         ) do
      {:ok, %Req.Response{status: 200, body: %{"bars" => bars, "tv_ws" => tv_ws}}} ->
        mapped =
          Enum.reduce(bars || [], %{}, fn row, acc ->
            symbol = Map.get(row, "symbol")
            timeframe = Map.get(row, "timeframe")

            if is_binary(symbol) and is_binary(timeframe) do
              Map.put(acc, {symbol, timeframe}, normalize_tv_row(row))
            else
              acc
            end
          end)

        %{status: normalize_tv_status(tv_ws), bars: mapped, error: nil}

      {:ok, %Req.Response{status: status}} ->
        %{status: :http_error, bars: %{}, error: "status=#{status}"}

      {:error, reason} ->
        %{status: :transport_error, bars: %{}, error: inspect(reason)}
    end
  end

  defp attach_tv_snapshot(positions, tv_snapshot) do
    Enum.map(positions, fn position ->
      tv_symbol = to_tv_symbol(position)

      tv =
        if is_binary(tv_symbol) do
          frames =
            KillSwitch.position_watch_tv_timeframes()
            |> Enum.map(fn timeframe ->
              {timeframe, Map.get(tv_snapshot.bars, {tv_symbol, timeframe})}
            end)
            |> Enum.into(%{})

          %{
            symbol: tv_symbol,
            frames: frames
          }
        else
          nil
        end

      Map.put(position, :tv, tv)
    end)
  end

  defp normalize_tv_row(row) do
    bar = Map.get(row, "bar", %{}) || %{}
    open = to_float(Map.get(bar, "open"))
    close = to_float(Map.get(bar, "close"))
    age_ms = Map.get(row, "ageMs")

    %{
      timeframe: Map.get(row, "timeframe"),
      age_ms: if(is_number(age_ms), do: age_ms, else: to_float(age_ms)),
      timestamp: Map.get(bar, "timestamp"),
      open: open,
      high: to_float(Map.get(bar, "high")),
      low: to_float(Map.get(bar, "low")),
      close: close,
      volume: to_float(Map.get(bar, "volume")),
      direction:
        cond do
          close > open -> :bullish
          close < open -> :bearish
          true -> :flat
        end
    }
  end

  defp classify_tv_attention(nil, _tv_stale_ms), do: nil

  defp classify_tv_attention(%{frames: frames}, tv_stale_ms) when is_map(frames) do
    stale_frame =
      Enum.find(frames, fn {_timeframe, frame} ->
        is_map(frame) and is_number(frame.age_ms) and frame.age_ms >= tv_stale_ms
      end)

    bearish_frame =
      Enum.find(frames, fn {_timeframe, frame} ->
        is_map(frame) and frame.direction == :bearish
      end)

    cond do
      stale_frame ->
        {timeframe, frame} = stale_frame

        %{
          attention_type: :tv_bar_stale,
          reason: "TradingView #{timeframe} bar stale",
          tv_timeframe: timeframe,
          tv_age_ms: frame.age_ms
        }

      bearish_frame ->
        {timeframe, frame} = bearish_frame

        %{
          attention_type: :tv_live_bearish,
          reason: "TradingView #{timeframe} live candle bearish",
          tv_timeframe: timeframe,
          tv_age_ms: frame.age_ms,
          tv_open: frame.open,
          tv_close: frame.close
        }

      true ->
        nil
    end
  end

  defp classify_tv_attention(_, _tv_stale_ms), do: nil

  defp normalize_setup_type(nil), do: nil

  defp normalize_setup_type(value) do
    value
    |> to_string()
    |> String.trim()
    |> String.downcase()
    |> case do
      "" -> nil
      other -> other
    end
  end

  defp normalize_json_map(value) when is_map(value), do: value
  defp normalize_json_map(_), do: %{}

  defp strategy_adjust_gain_pct(base, "mean_reversion"), do: base * 0.6
  defp strategy_adjust_gain_pct(base, "trend_following"), do: base * 1.1
  defp strategy_adjust_gain_pct(base, "momentum_rotation"), do: base * 1.05
  defp strategy_adjust_gain_pct(base, _), do: base

  defp strategy_stop_loss_pct(base, "breakout"), do: base * 0.8
  defp strategy_stop_loss_pct(base, "mean_reversion"), do: base * 1.1
  defp strategy_stop_loss_pct(base, _), do: base

  defp classify_strategy_tv_attention(position, setup_type, monitoring_plan, adjust_gain_pct) do
    triggers =
      monitoring_plan
      |> Map.get("triggers", monitoring_plan[:triggers] || [])
      |> List.wrap()
      |> Enum.map(&to_string/1)

    tv = position[:tv] || %{}
    frames = Map.get(tv, :frames, %{})
    tv4h = Map.get(frames, "4h") || Map.get(frames, :"4h")
    tv1d = Map.get(frames, "1d") || Map.get(frames, :"1d")
    pnl_ratio = to_float(position[:pnl_ratio])

    cond do
      "tv_live_bearish" in triggers and setup_type == "mean_reversion" and
          pnl_ratio >= adjust_gain_pct * 0.8 and bearish_frame?(tv4h) ->
        %{
          attention_type: :partial_adjust_attention,
          reason: "strategy mean_reversion profit lock on live bearish",
          strategy_attention: "mean_reversion_profit_lock",
          tv_timeframe: "4h"
        }

      "tv_live_bearish" in triggers and setup_type in ["trend_following", "momentum_rotation"] and
          pnl_ratio >= adjust_gain_pct and bearish_frame?(tv4h) and bearish_frame?(tv1d) ->
        %{
          attention_type: :partial_adjust_attention,
          reason: "strategy trend follow weakening on multi-timeframe bearish",
          strategy_attention: "trend_following_trail",
          tv_timeframe: "4h+1d"
        }

      "stop_loss_attention" in triggers and setup_type == "breakout" and
          pnl_ratio <= -0.02 and bearish_frame?(tv4h) and bearish_frame?(tv1d) ->
        %{
          attention_type: :stop_loss_attention,
          reason: "strategy breakout failed with multi-timeframe bearish follow-through",
          strategy_attention: "breakout_failed",
          tv_timeframe: "4h+1d"
        }

      true ->
        nil
    end
  end

  defp bearish_frame?(%{direction: :bearish}), do: true
  defp bearish_frame?(_), do: false

  defp classify_backtest_drift_attention(_position, %{}) do
    nil
  end

  defp classify_backtest_drift_attention(position, backtest_plan) do
    if not KillSwitch.position_watch_backtest_drift_enabled?() do
      nil
    else
      baseline = normalize_json_map(Map.get(backtest_plan, "latestBaseline", backtest_plan[:latestBaseline]))
      baseline_created_at = parse_ts(Map.get(baseline, "createdAt", baseline[:createdAt]))
      latest_created_at = parse_ts(position[:backtest_created_at])
      latest_trades = trunc(to_float(position[:backtest_total_trades]))

      cond do
        map_size(baseline) == 0 ->
          nil

        is_nil(latest_created_at) or is_nil(baseline_created_at) ->
          nil

        DateTime.compare(latest_created_at, baseline_created_at) != :gt ->
          nil

        latest_trades < KillSwitch.position_watch_backtest_drift_min_trades() ->
          nil

        true ->
          baseline_sharpe = json_float(baseline, "sharpe")
          latest_sharpe = to_float(position[:backtest_sharpe])
          baseline_return = json_float(baseline, "totalReturn")
          latest_return = to_float(position[:backtest_total_return])
          sharpe_drop = if finite?(baseline_sharpe), do: baseline_sharpe - latest_sharpe, else: nil
          return_drop = if finite?(baseline_return), do: baseline_return - latest_return, else: nil
          pnl_ratio = to_float(position[:pnl_ratio])

          severe? =
            (finite?(sharpe_drop) and sharpe_drop >= KillSwitch.position_watch_backtest_drift_exit_sharpe_drop()) or
              (finite?(return_drop) and
                 return_drop >= KillSwitch.position_watch_backtest_drift_exit_return_drop_pct())

          moderate? =
            (finite?(sharpe_drop) and
               sharpe_drop >= KillSwitch.position_watch_backtest_drift_adjust_sharpe_drop()) or
              (finite?(return_drop) and
                 return_drop >= KillSwitch.position_watch_backtest_drift_adjust_return_drop_pct())

          cond do
            severe? and pnl_ratio < 0 ->
              %{
                attention_type: :backtest_drift_attention,
                reason: "active backtest drift severe",
                strategy_attention: "backtest_drift_exit",
                backtest_sharpe_drop: sharpe_drop,
                backtest_return_drop_pct: return_drop
              }

            moderate? ->
              %{
                attention_type: :backtest_drift_attention,
                reason: "active backtest drift moderate",
                strategy_attention: "backtest_drift_adjust",
                backtest_sharpe_drop: sharpe_drop,
                backtest_return_drop_pct: return_drop
              }

            true ->
              nil
          end
      end
    end
  end

  defp json_float(map, key) do
    value = Map.get(map, key, Map.get(map, String.to_atom(key), nil))

    case value do
      nil -> nil
      "" -> nil
      _ -> to_float(value)
    end
  rescue
    _ -> nil
  end

  defp finite?(value) when is_number(value), do: value == value
  defp finite?(_), do: false

  defp parse_ts(nil), do: nil

  defp parse_ts(%DateTime{} = value), do: value

  defp parse_ts(%NaiveDateTime{} = value) do
    DateTime.from_naive(value, "Etc/UTC") |> elem(1)
  rescue
    _ -> nil
  end

  defp parse_ts(value) when is_binary(value) do
    case DateTime.from_iso8601(value) do
      {:ok, dt, _} ->
        dt

      _ ->
        case NaiveDateTime.from_iso8601(value) do
          {:ok, ndt} -> parse_ts(ndt)
          _ -> nil
        end
    end
  end

  defp parse_ts(_), do: nil

  defp normalize_tv_status("connected"), do: :connected
  defp normalize_tv_status("disconnected"), do: :disconnected
  defp normalize_tv_status(_), do: :unknown

  defp effective_interval_ms(snapshot, state) do
    now = DateTime.utc_now()

    dynamic_active? =
      is_integer(state.dynamic_interval_ms) and state.dynamic_interval_ms > 0 and
        match?(%DateTime{}, state.dynamic_interval_until) and
        DateTime.compare(state.dynamic_interval_until, now) == :gt

    if dynamic_active? do
      state.dynamic_interval_ms
    else
      snapshot
      |> Map.get(:watch_context, %{})
      |> Map.get(:recommended_interval_ms, KillSwitch.position_watch_interval_ms())
    end
  end

  defp market_from_exchange(exchange) do
    case to_string(exchange || "") do
      "binance" -> :crypto
      "kis" -> :domestic
      "kis_overseas" -> :overseas
      _ -> :unknown
    end
  end

  defp to_tv_symbol(position) do
    symbol = to_string(position[:symbol] || "")
    exchange = to_string(position[:exchange] || "")

    cond do
      exchange == "binance" and String.contains?(symbol, "/") ->
        "BINANCE:" <> String.replace(symbol, "/", "")

      exchange == "kis" and Regex.match?(~r/^\d{6}$/, symbol) ->
        "KRX:" <> symbol

      exchange == "kis_overseas" and Regex.match?(~r/^[A-Z]{1,10}$/, symbol) ->
        to_us_tv_symbol(symbol)

      true ->
        nil
    end
  end

  # 미국장은 현재 포지션 symbol에 거래소 메타가 항상 함께 오지 않아서,
  # 자주 쓰는 종목/ETF는 명시 매핑하고 나머지는 NASDAQ 우선으로 본다.
  # 필요시 NYSE/AMEX 매핑 테이블을 계속 확장하면 된다.
  defp to_us_tv_symbol(symbol) do
    case symbol do
      "AAPL" -> "NASDAQ:AAPL"
      "AMD" -> "NASDAQ:AMD"
      "AMZN" -> "NASDAQ:AMZN"
      "ASTS" -> "NASDAQ:ASTS"
      "MSFT" -> "NASDAQ:MSFT"
      "NFLX" -> "NASDAQ:NFLX"
      "NVDA" -> "NASDAQ:NVDA"
      "NVTS" -> "NASDAQ:NVTS"
      "OPEN" -> "NASDAQ:OPEN"
      "POET" -> "NASDAQ:POET"
      "QQQ" -> "NASDAQ:QQQ"
      "TSLA" -> "NASDAQ:TSLA"
      "CAR" -> "NYSE:CAR"
      "DTE" -> "NYSE:DTE"
      "GE" -> "NYSE:GE"
      "UNH" -> "NYSE:UNH"
      "SPY" -> "AMEX:SPY"
      _ -> "NASDAQ:" <> symbol
    end
  end

  defp maybe_broadcast(snapshot, previous_snapshot) do
    previous_attention = Map.get(previous_snapshot || %{}, :attention_count, 0)
    current_attention = Map.get(snapshot, :attention_count, 0)

    if current_attention > 0 and
         (previous_attention != current_attention or previous_attention == 0) do
      Logger.warning("[루나V2/PositionWatch] attention #{current_attention}건 감지")

      Phoenix.PubSub.broadcast(
        Luna.V2.PubSub,
        @topic,
        {:position_watch_attention, snapshot}
      )
    end
  end

  defp maybe_trigger_active_backtests(snapshot, state) do
    if not KillSwitch.position_watch_active_backtest_enabled?() do
      state
    else
      now = DateTime.utc_now()
      cooldowns = prune_backtest_cooldowns(state.active_backtest_cooldowns, now)

      candidates =
        snapshot
        |> Map.get(:attention, [])
        |> Enum.filter(&active_backtest_candidate?/1)
        |> Enum.uniq_by(fn item ->
          {to_string(item[:exchange] || ""), to_string(item[:symbol] || ""),
           to_string(item[:attention_type] || "")}
        end)
        |> Enum.take(KillSwitch.position_watch_active_backtest_max_per_tick())

      {updated_cooldowns, triggered_count} =
        Enum.reduce(candidates, {cooldowns, 0}, fn candidate, {acc, count} ->
          key = backtest_key(candidate)

          if Map.has_key?(acc, key) do
            {acc, count}
          else
            trigger_active_backtest(candidate)
            {Map.put(acc, key, cooldown_expiry(now)), count + 1}
          end
        end)

      if triggered_count > 0 do
        Logger.info("[루나V2/PositionWatch] 액티브 백테스트 #{triggered_count}건 트리거")
      end

      %{state | active_backtest_cooldowns: updated_cooldowns}
    end
  end

  defp maybe_trigger_strategy_exit_previews(snapshot, state) do
    if not KillSwitch.position_watch_strategy_exit_enabled?() do
      state
    else
      now = DateTime.utc_now()
      cooldowns = prune_backtest_cooldowns(state.strategy_exit_cooldowns, now)

      candidates =
        snapshot
        |> Map.get(:attention, [])
        |> Enum.filter(&strategy_exit_candidate?/1)
        |> Enum.uniq_by(fn item ->
          {to_string(item[:exchange] || ""), to_string(item[:symbol] || ""),
           to_string(item[:trade_mode] || item[:tradeMode] || "normal")}
        end)
        |> Enum.take(KillSwitch.position_watch_strategy_exit_max_per_tick())

      {updated_cooldowns, triggered_count} =
        Enum.reduce(candidates, {cooldowns, 0}, fn candidate, {acc, count} ->
          key = strategy_exit_key(candidate)

          if Map.has_key?(acc, key) do
            {acc, count}
          else
            trigger_strategy_exit_preview(candidate)
            expiry =
              DateTime.add(
                now,
                KillSwitch.position_watch_strategy_exit_cooldown_minutes() * 60,
                :second
              )

            {Map.put(acc, key, expiry), count + 1}
          end
        end)

      if triggered_count > 0 do
        Logger.info("[루나V2/PositionWatch] strategy-exit preview #{triggered_count}건 트리거")
      end

      %{state | strategy_exit_cooldowns: updated_cooldowns}
    end
  end

  defp active_backtest_candidate?(candidate) do
    exchange = to_string(candidate[:exchange] || "")
    attention = candidate[:attention_type]

    exchange in ["binance", "kis", "kis_overseas"] and
      attention in [:stop_loss_attention, :partial_adjust_attention, :tv_live_bearish, :backtest_drift_attention]
  end

  defp strategy_exit_candidate?(candidate) do
    exchange = to_string(candidate[:exchange] || "")
    attention = candidate[:attention_type]

    exchange in ["binance", "kis", "kis_overseas"] and
      attention in [:stop_loss_attention, :backtest_drift_attention]
  end

  defp backtest_key(candidate) do
    exchange = to_string(candidate[:exchange] || "")
    symbol = to_string(candidate[:symbol] || "")
    attention = to_string(candidate[:attention_type] || "")
    "#{exchange}:#{symbol}:#{attention}"
  end

  defp strategy_exit_key(candidate) do
    exchange = to_string(candidate[:exchange] || "")
    symbol = to_string(candidate[:symbol] || "")
    trade_mode = to_string(candidate[:trade_mode] || candidate[:tradeMode] || "normal")
    "#{exchange}:#{symbol}:#{trade_mode}"
  end

  defp cooldown_expiry(now) do
    DateTime.add(now, KillSwitch.position_watch_active_backtest_cooldown_minutes() * 60, :second)
  end

  defp prune_backtest_cooldowns(cooldowns, now) do
    Enum.reduce(cooldowns, %{}, fn {key, expires_at}, acc ->
      if match?(%DateTime{}, expires_at) and DateTime.compare(expires_at, now) == :gt do
        Map.put(acc, key, expires_at)
      else
        acc
      end
    end)
  end

  defp trigger_active_backtest(candidate) do
    symbol = to_string(candidate[:symbol] || "")
    exchange = to_string(candidate[:exchange] || "")
    attention = to_string(candidate[:attention_type] || "")
    days = Integer.to_string(KillSwitch.position_watch_active_backtest_days())

    repo_root = "/Users/alexlee/projects/ai-agent-system"
    investment_dir = Path.join(repo_root, "bots/investment")

    Task.start(fn ->
      Logger.info("[루나V2/PositionWatch] 액티브 백테스트 시작 #{symbol} #{attention}")

      case System.cmd(
             "npm",
             [
               "--prefix",
               investment_dir,
               "run",
               "runtime:active-backtest",
               "--",
               "--symbol=#{symbol}",
               "--market=#{exchange}",
               "--attention=#{attention}",
               "--source=position_watch",
               "--days=#{days}",
               "--json"
             ],
             stderr_to_stdout: true,
             cd: investment_dir,
             env: [{"PAPER_MODE", "false"}]
           ) do
        {output, 0} ->
          Logger.info(
            "[루나V2/PositionWatch] 액티브 백테스트 완료 #{symbol} #{attention} #{String.trim(output)}"
          )

        {output, code} ->
          Logger.warning(
            "[루나V2/PositionWatch] 액티브 백테스트 실패 #{symbol} #{attention} exit=#{code} #{String.trim(output)}"
          )
      end
    end)
  end

  defp trigger_strategy_exit_preview(candidate) do
    symbol = to_string(candidate[:symbol] || "")
    exchange = to_string(candidate[:exchange] || "")
    trade_mode = to_string(candidate[:trade_mode] || candidate[:tradeMode] || "normal")

    repo_root = "/Users/alexlee/projects/ai-agent-system"
    investment_dir = Path.join(repo_root, "bots/investment")

    Task.start(fn ->
      Logger.info("[루나V2/PositionWatch] strategy-exit preview 시작 #{symbol} #{exchange}/#{trade_mode}")

      case System.cmd(
             "npm",
             [
               "--prefix",
               investment_dir,
               "run",
               "runtime:strategy-exit",
               "--",
               "--symbol=#{symbol}",
               "--exchange=#{exchange}",
               "--trade-mode=#{trade_mode}",
               "--json"
             ],
             stderr_to_stdout: true,
             cd: investment_dir,
             env: [{"PAPER_MODE", "false"}]
           ) do
        {output, 0} ->
          Logger.info(
            "[루나V2/PositionWatch] strategy-exit preview 완료 #{symbol} #{exchange}/#{trade_mode} #{String.trim(output)}"
          )

        {output, code} ->
          Logger.warning(
            "[루나V2/PositionWatch] strategy-exit preview 실패 #{symbol} #{exchange}/#{trade_mode} exit=#{code} #{String.trim(output)}"
          )
      end
    end)
  end

  defp to_float(nil), do: 0.0
  defp to_float(%Decimal{} = value), do: Decimal.to_float(value)
  defp to_float(value) when is_number(value), do: value * 1.0
  defp to_float(_), do: 0.0

  defp schedule(interval_ms) do
    Process.send_after(self(), :tick, max(5_000, interval_ms))
  end
end
