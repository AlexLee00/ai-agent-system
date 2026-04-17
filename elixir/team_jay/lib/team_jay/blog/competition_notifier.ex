defmodule TeamJay.Blog.CompetitionNotifier do
  @moduledoc """
  블로그팀 Phase 4 경쟁 실험 알림 도우미.

  경쟁 실험 다이제스트를 운영 메시지로 렌더링하고,
  필요할 때 허브 알람으로 전송한다.
  """

  alias TeamJay.Blog.CompetitionDigest
  alias Jay.Core.HubClient

  def build_message(style \\ :ops) do
    CompetitionDigest.build()
    |> format(style)
    |> prepend_header()
  end

  def notify(opts \\ []) do
    style = Keyword.get(opts, :style, :ops)
    send? = Keyword.get(opts, :send, false)

    message = build_message(style)

    if send? do
      response = HubClient.post_alarm(message, "blog", "blog-phase4")
      %{sent: true, message: message, response: summarize_response(response)}
    else
      %{sent: false, message: message}
    end
  end

  defp format(digest, :brief) do
    health = Map.get(digest, :health, %{})
    quality = Map.get(digest, :quality, %{})
    recent =
      digest
      |> Map.get(:recent_topics, [])
      |> List.first()

    parts = [
      "phase4=#{render_health(Map.get(health, :status, :warming_up))}",
      "comp=#{Map.get(health, :total_count, 0)}",
      "done=#{Map.get(health, :completed_count, 0)}",
      "timeout=#{Map.get(health, :timeout_count, 0)}"
    ]

    parts =
      case Map.get(quality, :avg_quality_diff) do
        nil -> parts
        value -> parts ++ ["diff=#{value}"]
      end

    parts =
      case render_recent(recent) do
        "none" -> parts
        value -> parts ++ ["last=#{value}"]
      end

    Enum.join(parts, " ")
  end

  defp format(digest, :ops) do
    health = Map.get(digest, :health, %{})
    winners = Map.get(digest, :winners, %{})
    quality = Map.get(digest, :quality, %{})
    recent =
      digest
      |> Map.get(:recent_topics, [])
      |> Enum.take(3)
      |> Enum.map(&render_recent/1)
      |> Enum.reject(&(&1 == "none"))

    [
      "블로그 Phase 4 경쟁 실험 리포트",
      "상태: #{render_health(Map.get(health, :status, :warming_up))}",
      "Competitions: #{Map.get(health, :total_count, 0)}건",
      "Completed: #{Map.get(health, :completed_count, 0)} / Running: #{Map.get(health, :running_count, 0)} / Pending: #{Map.get(health, :pending_count, 0)} / Timeout: #{Map.get(health, :timeout_count, 0)}",
      "Winners: A #{Map.get(winners, :a_count, 0)} / B #{Map.get(winners, :b_count, 0)} / none #{Map.get(winners, :none_count, 0)}",
      "Avg quality diff: #{Map.get(quality, :avg_quality_diff, "n/a")}",
      "최근 경쟁: #{if recent == [], do: "none", else: Enum.join(recent, ", ")}",
      "추천: #{render_recommendation(digest)}"
    ]
    |> Enum.join("\n")
  end

  defp render_recent(nil), do: "none"

  defp render_recent(item) do
    topic = Map.get(item, :topic, "unknown")
    status = Map.get(item, :status, "unknown")
    winner = Map.get(item, :winner) || "none"
    "#{topic}:#{status}/#{winner}"
  end

  defp render_recommendation(digest) do
    digest
    |> Map.get(:recommendations, [])
    |> List.first()
    |> case do
      nil -> "현재는 별도 권고 없음"
      value -> value
    end
  end

  defp prepend_header(message) do
    "🏁 블로그 Phase 4 경쟁 실험 리포트\n" <> message
  end

  defp render_health(:ok), do: "정상"
  defp render_health(:warn), do: "주의"
  defp render_health(:active), do: "진행중"
  defp render_health(:cooldown), do: "정리중"
  defp render_health(other), do: to_string(other)

  defp summarize_response({:ok, %{status: status, body: body}}) do
    %{ok: status in 200..299, status: status, body: body}
  end

  defp summarize_response({:error, reason}) do
    %{ok: false, error: inspect(reason)}
  end

  defp summarize_response(other) do
    %{ok: false, error: inspect(other)}
  end
end
