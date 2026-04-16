defmodule TeamJay.Jay.WeeklyReport do
  @moduledoc """
  주간 리포트 생성기 — 매주 월요일 07:30 KST.
  7일 데이터 종합 → 팀별 성과 분석 → 마스터 텔레그램 발송.
  """

  require Logger
  alias TeamJay.Jay.{TeamConnector, Topics, DailyBriefing}

  @teams TeamConnector.all_teams()

  @doc "주간 리포트 생성 + 텔레그램 발송"
  def run do
    Logger.info("[WeeklyReport] 주간 리포트 생성 시작")

    week_start = Date.add(Date.utc_today(), -7) |> Date.to_string()
    week_end   = Date.utc_today() |> Date.to_string()

    team_data = TeamConnector.collect_all()
    highlights = extract_highlights(team_data)
    report = build_report(team_start: week_start, team_end: week_end,
                          team_data: team_data, highlights: highlights)

    Topics.broadcast(:weekly_report_ready, %{report: report, week_start: week_start})
    TeamJay.HubClient.post_alarm(report, "jay", "weekly_report")

    record_to_sigma(week_start, week_end, report, highlights)
    Logger.info("[WeeklyReport] 완료 (#{String.length(report)}자)")
    :ok
  rescue
    e ->
      Logger.error("[WeeklyReport] 실패: #{Exception.message(e)}")
      :error
  end

  # ────────────────────────────────────────────────────────────────
  # 리포트 생성
  # ────────────────────────────────────────────────────────────────

  defp build_report(opts) do
    week_start = opts[:team_start]
    week_end   = opts[:team_end]
    team_data  = opts[:team_data]
    highlights = opts[:highlights]

    header = """
    📅 *제이 주간 리포트* (#{week_start} ~ #{week_end})
    ━━━━━━━━━━━━━━━━━━━━━━━
    """

    team_sections = @teams
      |> Enum.map(fn team -> DailyBriefing.format_team_week(team, team_data[team]) end)
      |> Enum.reject(&is_nil/1)
      |> Enum.join("\n")

    highlight_section = if highlights != [] do
      "\n🏆 *주간 하이라이트*\n" <> Enum.join(highlights, "\n")
    else
      ""
    end

    footer = "\n━━━━━━━━━━━━━━━━━━━━━━━\n" <>
             "🤖 제이 자동 주간 리포트"

    header <> team_sections <> highlight_section <> footer
  end

  # ────────────────────────────────────────────────────────────────
  # 하이라이트 추출
  # ────────────────────────────────────────────────────────────────

  defp extract_highlights(team_data) do
    highlights = []

    # 루나 PnL 우수
    highlights = case team_data[:luna] do
      %{pnl_usdt_7d: pnl} when is_number(pnl) and pnl > 100 ->
        ["💰 루나팀 주간 PnL: +$#{Float.round(pnl * 1.0, 2)} 달성!" | highlights]
      _ -> highlights
    end

    # 블로 발행 우수
    highlights = case team_data[:blog] do
      %{published_7d: n} when n >= 5 ->
        ["✍️ 블로팀 주간 #{n}건 발행 달성!" | highlights]
      _ -> highlights
    end

    # 스카 예약 완료율
    highlights = case team_data[:ska] do
      %{completed: c, bookings_today: t} when t > 0 ->
        rate = Float.round(c / t * 100, 1)
        if rate >= 90, do: ["☕ 스카팀 예약 완료율 #{rate}% 달성!" | highlights], else: highlights
      _ -> highlights
    end

    # 시스템 완전 정상
    highlights = case team_data[:claude] do
      %{unhealthy_count: 0, total_services: n} when n > 0 ->
        ["🔧 클로드팀 서비스 #{n}개 전부 정상!" | highlights]
      _ -> highlights
    end

    Enum.reverse(highlights)
  end

  # ────────────────────────────────────────────────────────────────
  # Sigma DB 기록
  # ────────────────────────────────────────────────────────────────

  defp record_to_sigma(week_start, week_end, report, highlights) do
    TeamJay.Jay.Sigma.Feedback.record_daily_run(
      %{week_start: week_start, week_end: week_end, type: "weekly"},
      %{highlight_count: length(highlights)},
      report,
      0,
      0
    )
  rescue
    _ -> :ok
  end
end
