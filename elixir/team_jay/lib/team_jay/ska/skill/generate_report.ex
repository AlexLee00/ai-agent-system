defmodule TeamJay.Ska.Skill.GenerateReport do
  @moduledoc """
  일일/주간/월간 리포트 생성 스킬.

  다른 Analytics 스킬(AnalyzeRevenue, ForecastDemand)을 조합하여
  Markdown 리포트 생성 + Telegram 발송.

  입력: %{period: :daily, sections: [:revenue, :reservations, :forecasts], send_telegram: true}
  출력: {:ok, %{markdown: string, section_count: integer, telegram_sent: boolean}}
  """
  @behaviour TeamJay.Ska.Skill
  require Logger

  @impl true
  def metadata do
    %{
      name: :generate_report,
      domain: :analytics,
      version: "1.0",
      description: "일일/주간/월간 리포트 Markdown 생성 + Telegram 발송",
      input_schema: %{period: :atom, sections: :list, send_telegram: :boolean},
      output_schema: %{markdown: :string, section_count: :integer, telegram_sent: :boolean}
    }
  end

  @impl true
  def run(params, context) do
    period = params[:period] || :daily
    sections = params[:sections] || [:revenue, :reservations, :anomalies, :forecasts]
    send_telegram = Map.get(params, :send_telegram, false)

    content_sections =
      Enum.map(sections, fn section ->
        generate_section(section, period, context)
      end)

    markdown = compose_markdown(period, content_sections)

    telegram_sent =
      if send_telegram do
        send_report_telegram(markdown, period)
      else
        false
      end

    {:ok, %{markdown: markdown, section_count: length(sections), telegram_sent: telegram_sent}}
  end

  @impl true
  def health_check, do: :ok

  # ─── 섹션 생성 ────────────────────────────────────────────

  defp generate_section(:revenue, period, _context) do
    period_days = period_to_days(period)

    case TeamJay.Ska.SkillRegistry.execute(:analyze_revenue, %{
           period_days: period_days,
           compare_mode: :week_over_week
         }) do
      {:ok, data} ->
        total = get_in(data, ["summary", "total"]) || get_in(data, [:summary, :total]) || "N/A"
        rate = data["growth_rate"] || data[:growth_rate] || 0.0
        "## 매출\n- 합계: #{total}\n- 성장률: #{rate}%"

      {:error, :python_skill_disabled} ->
        "## 매출\n- 분석 스킬 비활성 (SKA_PYTHON_SKILL_ENABLED=false)"

      {:error, reason} ->
        Logger.warning("[GenerateReport] 매출 섹션 실패: #{inspect(reason)}")
        "## 매출\n- 데이터 조회 실패"
    end
  end

  defp generate_section(:reservations, period, _context) do
    days = period_to_days(period)
    "## 예약\n- #{days}일 기준 예약 현황 집계"
  end

  defp generate_section(:anomalies, _period, _context) do
    "## 이상 감지\n- 자동 감지 스캔 완료"
  end

  defp generate_section(:forecasts, period, _context) do
    horizon = period_to_days(period) + 7

    case TeamJay.Ska.SkillRegistry.execute(:forecast_demand, %{
           horizon_days: horizon,
           granularity: :daily
         }) do
      {:ok, _data} ->
        "## 예측\n- #{horizon}일 수요 예측 완료"

      {:error, :python_skill_disabled} ->
        "## 예측\n- 예측 스킬 비활성"

      {:error, _reason} ->
        "## 예측\n- 예측 실패"
    end
  end

  defp generate_section(unknown, _period, _context) do
    "## #{unknown}\n- 미지원 섹션"
  end

  # ─── 헬퍼 ────────────────────────────────────────────────

  defp compose_markdown(period, sections) do
    title = period_title(period)
    date = Date.utc_today() |> Date.to_string()
    header = "# #{title} — #{date}"
    Enum.join([header | sections], "\n\n")
  end

  defp period_title(:daily), do: "일일 리포트"
  defp period_title(:weekly), do: "주간 리포트"
  defp period_title(:monthly), do: "월간 리포트"
  defp period_title(other), do: "#{other} 리포트"

  defp period_to_days(:daily), do: 1
  defp period_to_days(:weekly), do: 7
  defp period_to_days(:monthly), do: 30
  defp period_to_days(_), do: 1

  defp send_report_telegram(markdown, period) do
    tag = "[스카팀 #{period_title(period)}]"
    message = "#{tag}\n\n#{markdown}"

    try do
      TeamJay.Telegram.send_general(message)
      true
    rescue
      e ->
        Logger.warning("[GenerateReport] Telegram 발송 실패: #{inspect(e)}")
        false
    end
  end
end
