defmodule Luna.V2.MarketHoursGate do
  @moduledoc """
  시장 시간 게이트 — 시장별 운영 시간 제어.

  crypto:   24/7 (항상 활성)
  domestic: 평일 09:00~15:30 KST
  overseas: 평일 22:30~05:00 KST (미국 주식)
  """

  @doc "현재 시장이 열려 있는지 확인."
  def open?(market) do
    now_kst = DateTime.utc_now() |> DateTime.add(9 * 3600, :second)
    check_open(market, now_kst)
  end

  @doc "시장이 열릴 때까지 남은 초 (이미 열려 있으면 0)."
  def seconds_until_open(market) do
    if open?(market), do: 0, else: calc_next_open(market)
  end

  @doc "현재 활성 시장 목록."
  def active_markets do
    [:crypto, :domestic, :overseas]
    |> Enum.filter(&open?/1)
  end

  # ─── Internal ───────────────────────────────────────────────────

  defp check_open(:crypto, _now), do: true

  defp check_open(:domestic, now) do
    day = Date.day_of_week(DateTime.to_date(now))
    h = now.hour
    m = now.minute
    # 평일 09:00:00 ~ 15:29:59 KST
    weekday?(day) and
      (h > 9 or (h == 9 and m >= 0)) and
      (h < 15 or (h == 15 and m < 30))
  end

  defp check_open(:overseas, now) do
    day = Date.day_of_week(DateTime.to_date(now))
    h = now.hour
    m = now.minute
    # 평일 22:30:00 ~ 05:00:00 KST (익일 포함)
    weekday?(day) and
      ((h >= 22 and m >= 30) or h < 5)
  end

  defp check_open(_, _), do: false

  defp weekday?(day), do: day in 1..5

  defp calc_next_open(:domestic) do
    now_kst = DateTime.utc_now() |> DateTime.add(9 * 3600, :second)
    today = DateTime.to_date(now_kst)
    days_ahead = find_next_weekday(today)
    open_dt = %{now_kst | year: today.year + 0, month: today.month, day: today.day + days_ahead,
                           hour: 9, minute: 0, second: 0, microsecond: {0, 0}}
    max(0, DateTime.diff(open_dt, now_kst))
  end

  defp calc_next_open(:overseas) do
    now_kst = DateTime.utc_now() |> DateTime.add(9 * 3600, :second)
    today = DateTime.to_date(now_kst)
    days_ahead = find_next_weekday(today)
    open_dt = %{now_kst | year: today.year + 0, month: today.month, day: today.day + days_ahead,
                           hour: 22, minute: 30, second: 0, microsecond: {0, 0}}
    max(0, DateTime.diff(open_dt, now_kst))
  end

  defp calc_next_open(_), do: 0

  defp find_next_weekday(date) do
    day = Date.day_of_week(date)
    cond do
      day in 1..4 -> 1          # Mon~Thu → 다음날
      day == 5    -> 3          # Fri → 월요일 (3일 후)
      day == 6    -> 2          # Sat → 월요일
      day == 7    -> 1          # Sun → 월요일
      true        -> 1
    end
  end
end
