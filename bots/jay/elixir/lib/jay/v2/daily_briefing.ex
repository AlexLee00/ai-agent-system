defmodule Jay.V2.DailyBriefing do
  @moduledoc """
  9팀 데이터를 종합한 일일 브리핑 생성기.
  growth_cycle.ex가 07:30에 호출 → 텔레그램 발송.
  """

  require Logger

  @doc "팀 데이터 맵 → 텔레그램 브리핑 텍스트 생성"
  def generate(team_data, date) do
    sections = Enum.map(team_data, fn {team, data} ->
      format_team_section(team, data)
    end)

    cross_alerts = generate_cross_alerts(team_data)

    header = "📊 *제이 일일 브리핑* — #{date}\n" <>
             "━━━━━━━━━━━━━━━━━━━━━━━\n"

    body = Enum.join(sections, "\n")

    cross_section = if cross_alerts != "" do
      "\n⚡ *팀 간 연동 알림*\n#{cross_alerts}"
    else
      ""
    end

    footer = "\n━━━━━━━━━━━━━━━━━━━━━━━\n" <>
             "🤖 제이 자동 브리핑 | #{DateTime.utc_now() |> DateTime.to_iso8601()}"

    header <> body <> cross_section <> footer
  end

  @doc "주간 리포트용 팀 섹션 (공개 — WeeklyReport에서 호출)"
  def format_team_week(team, nil), do: "#{team_emoji_pub(team)} #{team}팀: 데이터 없음\n"
  def format_team_week(team, data), do: format_team_section(team, data)

  defp team_emoji_pub(:luna), do: "🌙"
  defp team_emoji_pub(:ska), do: "☕"
  defp team_emoji_pub(:blog), do: "✍️"
  defp team_emoji_pub(:claude), do: "🔧"
  defp team_emoji_pub(team), do: team_emoji(team)

  # ────────────────────────────────────────────────────────────────
  # 팀별 섹션 포맷
  # ────────────────────────────────────────────────────────────────

  defp format_team_section(:luna, nil), do: "🌙 루나팀: 데이터 수집 실패\n"
  defp format_team_section(:luna, data) do
    regime_emoji = regime_emoji(data[:market_regime])
    win_rate = calc_win_rate(data[:win_count], data[:trades_7d])
    "🌙 *루나팀*\n" <>
    "  #{regime_emoji} 시장: #{data[:market_regime]}\n" <>
    "  거래 #{data[:trades_7d]}건 | PnL #{format_pnl(data[:pnl_usdt_7d])} | 승률 #{win_rate}%\n" <>
    "  포지션 #{data[:live_positions]}개 활성\n"
  end

  defp format_team_section(:ska, nil), do: "☕ 스카팀: 데이터 수집 실패\n"
  defp format_team_section(:ska, data) do
    "☕ *스카팀*\n" <>
    "  예약 #{data[:bookings_today]}건 | 완료 #{data[:completed]}건 | 실패 #{data[:failed]}건\n" <>
    "  7일 매출 #{format_krw(data[:revenue_7d])}\n"
  end

  defp format_team_section(:blog, nil), do: "✍️ 블로팀: 데이터 수집 실패\n"
  defp format_team_section(:blog, data) do
    "✍️ *블로팀*\n" <>
    "  발행 #{data[:published_7d]}건(7일) | 준비 #{data[:ready_count]}건 | 초안 #{data[:draft_count]}건\n"
  end

  defp format_team_section(:claude, nil), do: "🔧 클로드팀: 데이터 수집 실패\n"
  defp format_team_section(:claude, data) do
    health_emoji = if data[:unhealthy_count] == 0, do: "✅", else: "⚠️"
    "🔧 *클로드팀*\n" <>
    "  #{health_emoji} 서비스 #{data[:total_services]}개 | 비정상 #{data[:unhealthy_count]}개\n"
  end

  defp format_team_section(team, nil), do: "#{team_emoji(team)} #{team}팀: 데이터 없음\n"
  defp format_team_section(team, data) do
    case data[:metric_type] do
      :platform_ops ->
        "#{team_emoji(team)} *#{team}팀*\n  배포 #{data[:deploys_7d]}건(7일)\n"
      :agent_health ->
        "#{team_emoji(team)} *#{team}팀*\n" <>
        "  에이전트 #{data[:active_agents]}명 | 평균점수 #{Float.round(data[:avg_score] * 1.0, 1)} | 저성과 #{data[:low_score_agents]}명\n"
      _ ->
        "#{team_emoji(team)} *#{team}팀*: #{inspect(data)}\n"
    end
  end

  # ────────────────────────────────────────────────────────────────
  # 팀 간 연동 알림 생성
  # ────────────────────────────────────────────────────────────────

  defp generate_cross_alerts(team_data) do
    alerts = []

    # 스카 매출 급감 감지
    alerts = case team_data[:ska] do
      %{revenue_7d: rev} when is_number(rev) ->
        # TODO: 전주 대비 계산 (현재는 절대값 임계치)
        if rev < 100_000 do
          alerts ++ ["⬇️ 스카 매출 저조 (#{format_krw(rev)}) → 블로팀 프로모션 검토"]
        else
          alerts
        end
      _ -> alerts
    end

    # 클로드 시스템 위험 감지
    alerts = case team_data[:claude] do
      %{unhealthy_count: n} when n >= 3 ->
        alerts ++ ["🚨 시스템 서비스 #{n}개 비정상 → 전체 워크로드 주의"]
      _ -> alerts
    end

    # 루나 포지션 폭증 감지
    alerts = case team_data[:luna] do
      %{live_positions: n} when n >= 10 ->
        alerts ++ ["📈 루나 포지션 #{n}개 활성 → 리스크 점검"]
      _ -> alerts
    end

    Enum.join(alerts, "\n")
  end

  # ────────────────────────────────────────────────────────────────
  # 유틸
  # ────────────────────────────────────────────────────────────────

  defp calc_win_rate(_, 0), do: 0
  defp calc_win_rate(nil, _), do: 0
  defp calc_win_rate(wins, total), do: Float.round(wins / total * 100, 1)

  defp format_pnl(nil), do: "N/A"
  defp format_pnl(pnl) when pnl >= 0, do: "+$#{Float.round(pnl * 1.0, 2)}"
  defp format_pnl(pnl), do: "-$#{Float.round(abs(pnl) * 1.0, 2)}"

  defp format_krw(nil), do: "N/A"
  defp format_krw(n) when is_integer(n), do: "#{:erlang.integer_to_binary(n)}원"
  defp format_krw(n), do: "#{trunc(n)}원"

  defp regime_emoji("bull"), do: "🚀"
  defp regime_emoji("bear"), do: "🐻"
  defp regime_emoji("volatile"), do: "⚡"
  defp regime_emoji("crisis"), do: "🚨"
  defp regime_emoji(_), do: "➡️"

  defp team_emoji(:worker), do: "⚙️"
  defp team_emoji(:platform), do: "🏗️"
  defp team_emoji(:darwin), do: "🔬"
  defp team_emoji(:justin), do: "⚖️"
  defp team_emoji(:video), do: "🎬"
  defp team_emoji(_), do: "🤖"
end
