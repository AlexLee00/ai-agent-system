defmodule Luna.V2.MarketHoursGate do
  @moduledoc """
  시장 시간 게이트 — 시장별 운영 시간 제어.

  - crypto: 24/7 (항상 활성)
  - domestic: KST 평일 09:00~15:30 + 한국 휴장일 반영
  - overseas: America/New_York 평일 09:30~16:00 + NYSE 휴장일 반영 (DST 자동)
  """

  @kst_tz "Asia/Seoul"
  @ny_tz "America/New_York"
  @holiday_cache_key {:luna, __MODULE__, :holiday_cache}
  @domestic_open {9, 0, 0}
  @domestic_close {15, 30, 0}
  @overseas_open {9, 30, 0}
  @overseas_close {16, 0, 0}

  @doc "현재 시장이 열려 있는지 확인."
  def open?(market), do: status(market).open

  @doc "시장 상태를 구조화해서 반환한다."
  def status(market), do: status(market, DateTime.utc_now())

  def status(:crypto, _now_utc) do
    %{
      market: :crypto,
      timezone: "UTC",
      open: true,
      session: :open_24h,
      reason: "crypto_24_7",
      market_date: Date.utc_today(),
      opens_at: nil,
      closes_at: nil,
      seconds_until_open: 0,
      seconds_until_close: nil
    }
  end

  def status(:domestic, now_utc) do
    now_kst = to_zone(now_utc, @kst_tz)
    market_date = DateTime.to_date(now_kst)
    open_at = at_time!(market_date, @domestic_open, @kst_tz)
    close_at = at_time!(market_date, @domestic_close, @kst_tz)
    holiday? = domestic_holiday?(market_date)
    weekday? = weekday?(market_date)

    within_session? =
      DateTime.compare(now_kst, open_at) in [:eq, :gt] and
        DateTime.compare(now_kst, close_at) == :lt

    open? = weekday? and not holiday? and within_session?
    next_open_at = if open?, do: open_at, else: next_open_datetime(:domestic, now_kst)

    %{
      market: :domestic,
      timezone: @kst_tz,
      open: open?,
      session: if(open?, do: :open, else: :closed),
      reason: domestic_reason(now_kst, holiday?, weekday?, open_at, close_at),
      market_date: market_date,
      opens_at: if(open?, do: open_at, else: next_open_at),
      closes_at: close_at,
      seconds_until_open: if(open?, do: 0, else: seconds_between(next_open_at, now_kst)),
      seconds_until_close: if(open?, do: seconds_between(close_at, now_kst), else: 0)
    }
  end

  def status(:overseas, now_utc) do
    now_ny = to_zone(now_utc, @ny_tz)
    market_date = DateTime.to_date(now_ny)
    open_at = at_time!(market_date, @overseas_open, @ny_tz)
    close_at = at_time!(market_date, @overseas_close, @ny_tz)
    holiday? = overseas_holiday?(market_date)
    weekday? = weekday?(market_date)

    within_session? =
      DateTime.compare(now_ny, open_at) in [:eq, :gt] and
        DateTime.compare(now_ny, close_at) == :lt

    open? = weekday? and not holiday? and within_session?
    next_open_at = if open?, do: open_at, else: next_open_datetime(:overseas, now_ny)

    %{
      market: :overseas,
      timezone: @ny_tz,
      open: open?,
      session: if(open?, do: :open, else: :closed),
      reason: overseas_reason(now_ny, holiday?, weekday?, open_at, close_at),
      market_date: market_date,
      opens_at: if(open?, do: open_at, else: next_open_at),
      closes_at: close_at,
      seconds_until_open: if(open?, do: 0, else: seconds_between(next_open_at, now_ny)),
      seconds_until_close: if(open?, do: seconds_between(close_at, now_ny), else: 0)
    }
  end

  def status(_market, _now_utc) do
    %{
      market: :unknown,
      timezone: "UTC",
      open: false,
      session: :unsupported,
      reason: "unsupported_market",
      market_date: Date.utc_today(),
      opens_at: nil,
      closes_at: nil,
      seconds_until_open: 0,
      seconds_until_close: 0
    }
  end

  @doc "시장이 열릴 때까지 남은 초 (이미 열려 있으면 0)."
  def seconds_until_open(market), do: status(market).seconds_until_open || 0

  @doc "현재 활성 시장 목록."
  def active_markets do
    [:crypto, :domestic, :overseas]
    |> Enum.filter(&open?/1)
  end

  # ─── Internal ───────────────────────────────────────────────────

  defp to_zone(datetime, timezone) do
    case DateTime.shift_zone(datetime, timezone) do
      {:ok, zoned} ->
        zoned

      {:error, _} when timezone == @kst_tz ->
        DateTime.add(datetime, 9 * 3600, :second)

      {:error, _} ->
        datetime
    end
  end

  defp at_time!(date, {hour, minute, second}, timezone) do
    {:ok, naive} = NaiveDateTime.new(date, Time.new!(hour, minute, second))
    {:ok, datetime} = DateTime.from_naive(naive, timezone)
    datetime
  end

  defp weekday?(date), do: Date.day_of_week(date) in 1..5

  defp seconds_between(%DateTime{} = future, %DateTime{} = now) do
    max(0, DateTime.diff(future, now, :second))
  end

  defp domestic_reason(_now, true, _weekday, _open_at, _close_at), do: "domestic_holiday"
  defp domestic_reason(_now, false, false, _open_at, _close_at), do: "domestic_weekend"

  defp domestic_reason(now, false, true, open_at, close_at) do
    cond do
      DateTime.compare(now, open_at) == :lt -> "before_domestic_open"
      DateTime.compare(now, close_at) in [:eq, :gt] -> "after_domestic_close"
      true -> "domestic_open"
    end
  end

  defp overseas_reason(_now, true, _weekday, _open_at, _close_at), do: "nyse_holiday"
  defp overseas_reason(_now, false, false, _open_at, _close_at), do: "nyse_weekend"

  defp overseas_reason(now, false, true, open_at, close_at) do
    cond do
      DateTime.compare(now, open_at) == :lt -> "before_nyse_open"
      DateTime.compare(now, close_at) in [:eq, :gt] -> "after_nyse_close"
      true -> "nyse_open"
    end
  end

  defp next_open_datetime(:domestic, now_kst) do
    date = DateTime.to_date(now_kst)
    open_today = at_time!(date, @domestic_open, @kst_tz)

    cond do
      domestic_trading_day?(date) and DateTime.compare(now_kst, open_today) == :lt ->
        open_today

      true ->
        next_date = find_next_trading_day(Date.add(date, 1), &domestic_trading_day?/1)
        at_time!(next_date, @domestic_open, @kst_tz)
    end
  end

  defp next_open_datetime(:overseas, now_ny) do
    date = DateTime.to_date(now_ny)
    open_today = at_time!(date, @overseas_open, @ny_tz)

    cond do
      overseas_trading_day?(date) and DateTime.compare(now_ny, open_today) == :lt ->
        open_today

      true ->
        next_date = find_next_trading_day(Date.add(date, 1), &overseas_trading_day?/1)
        at_time!(next_date, @overseas_open, @ny_tz)
    end
  end

  defp next_open_datetime(_, now), do: now

  defp find_next_trading_day(date, predicate) do
    if predicate.(date), do: date, else: find_next_trading_day(Date.add(date, 1), predicate)
  end

  defp domestic_trading_day?(date) do
    weekday?(date) and not domestic_holiday?(date)
  end

  defp overseas_trading_day?(date) do
    weekday?(date) and not overseas_holiday?(date)
  end

  defp domestic_holiday?(date) do
    cache_fetch({:domestic_holiday, Date.to_iso8601(date)}, 21_600, fn ->
      case Jay.Core.Repo.query(
             "SELECT holiday_flag FROM ska.environment_factors WHERE date = $1 LIMIT 1",
             [Date.to_iso8601(date)]
           ) do
        {:ok, %{rows: [[flag]]}} -> flag in [true, 1, "t", "true"]
        _ -> false
      end
    end)
  end

  defp overseas_holiday?(date) do
    # 관측일이 전년도/차년도에 걸칠 수 있어 양쪽 연도를 함께 확인한다.
    years = [date.year - 1, date.year, date.year + 1]

    Enum.any?(years, fn year ->
      MapSet.member?(nyse_holidays_for_year(year), date)
    end)
  end

  defp nyse_holidays_for_year(year) do
    cache_fetch({:nyse_holidays, year}, 86_400, fn ->
      fixed = [
        observed_date(Date.new!(year, 1, 1)),
        observed_date(Date.new!(year, 6, 19)),
        observed_date(Date.new!(year, 7, 4)),
        observed_date(Date.new!(year, 12, 25))
      ]

      floating = [
        nth_weekday_of_month(year, 1, 1, 3),
        nth_weekday_of_month(year, 2, 1, 3),
        Date.add(easter_date(year), -2),
        last_weekday_of_month(year, 5, 1),
        nth_weekday_of_month(year, 9, 1, 1),
        nth_weekday_of_month(year, 11, 4, 4)
      ]

      (fixed ++ floating)
      |> Enum.uniq()
      |> MapSet.new()
    end)
  end

  defp observed_date(date) do
    case Date.day_of_week(date) do
      6 -> Date.add(date, -1)
      7 -> Date.add(date, 1)
      _ -> date
    end
  end

  defp nth_weekday_of_month(year, month, weekday, nth) do
    first = Date.new!(year, month, 1)
    offset = Integer.mod(weekday - Date.day_of_week(first), 7) + 7 * (nth - 1)
    Date.add(first, offset)
  end

  defp last_weekday_of_month(year, month, weekday) do
    first = Date.new!(year, month, 1)
    last = Date.new!(year, month, Date.days_in_month(first))
    Date.add(last, -Integer.mod(Date.day_of_week(last) - weekday, 7))
  end

  defp easter_date(year) do
    a = rem(year, 19)
    b = div(year, 100)
    c = rem(year, 100)
    d = div(b, 4)
    e = rem(b, 4)
    f = div(b + 8, 25)
    g = div(b - f + 1, 3)
    h = rem(19 * a + b - d - g + 15, 30)
    i = div(c, 4)
    k = rem(c, 4)
    l = rem(32 + 2 * e + 2 * i - h - k, 7)
    m = div(a + 11 * h + 22 * l, 451)
    month = div(h + l - 7 * m + 114, 31)
    day = rem(h + l - 7 * m + 114, 31) + 1
    Date.new!(year, month, day)
  end

  defp cache_fetch(key, ttl_seconds, resolver) when ttl_seconds > 0 do
    now = System.system_time(:second)
    cache = :persistent_term.get(@holiday_cache_key, %{})

    case Map.get(cache, key) do
      %{expires_at: expires_at, value: value} when expires_at > now ->
        value

      _ ->
        value = resolver.()

        :persistent_term.put(
          @holiday_cache_key,
          Map.put(cache, key, %{expires_at: now + ttl_seconds, value: value})
        )

        value
    end
  end
end
