defmodule Sigma.V2.TelegramBridge do
  @moduledoc """
  Sigma V2 → Telegram 알림 브리지.
  Jay.Core.HubClient.post_alarm/3 경유.
  참조: bots/sigma/docs/PLAN.md §6 Phase 4
  """

  require Logger

  @doc "Tier 3 대기 Directive 마스터 알림."
  def notify_pending(directive, directive_id) do
    team = Map.get(directive, :team, "unknown")
    action = Map.get(directive, :action, %{})

    message = """
    🔔 Tier 3 Directive 승인 대기

    Team: #{team}
    Action: #{inspect(action)}

    GET /sigma/mailbox 에서 확인 후:
    승인: POST /sigma/mailbox/#{directive_id}/approve
    거절: POST /sigma/mailbox/#{directive_id}/reject
    """

    Jay.Core.HubClient.post_alarm(message, "sigma", "elixir")
  rescue
    e ->
      Logger.warning("[sigma/telegram] 알림 전송 실패: #{inspect(e)}")
      {:error, e}
  end

  @doc "주간 메타리뷰 보고."
  def notify_meta_review(report) do
    by_analyst = report[:by_analyst] || []
    what_worked = report[:what_worked] || []
    what_didnt = report[:what_didnt] || []

    top_analyst =
      case Enum.max_by(by_analyst, & &1[:rate], fn -> nil end) do
        nil -> "없음"
        a -> "#{a[:analyst] || "unknown"} (#{a[:rate]})"
      end

    message = """
    📊 시그마 주간 메타리뷰

    ✅ 성공 #{length(what_worked)}건 / ❌ 실패 #{length(what_didnt)}건
    🏆 최고 분석가: #{top_analyst}

    [What Worked]
    #{Enum.map_join(what_worked, "\n", &format_review_item(&1, :worked))}

    [What Didn't]
    #{Enum.map_join(what_didnt, "\n", &format_review_item(&1, :didnt))}
    """

    Jay.Core.HubClient.post_alarm(message, "sigma", "elixir")
  rescue
    e ->
      Logger.warning("[sigma/telegram] 메타리뷰 알림 실패: #{inspect(e)}")
      {:error, e}
  end

  defp format_review_item(item, mode) when is_map(item) do
    case mode do
      :worked -> "- #{item[:team] || "unknown"}: #{inspect(item[:action] || item)}"
      :didnt -> "- #{item[:team] || "unknown"}: #{item[:outcome] || inspect(item)}"
    end
  end

  defp format_review_item(item, _mode), do: "- #{inspect(item)}"
end
