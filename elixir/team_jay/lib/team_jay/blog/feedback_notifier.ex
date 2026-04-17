defmodule TeamJay.Blog.FeedbackNotifier do
  @moduledoc """
  블로그팀 Phase 3 피드백 알림 도우미.

  피드백 다이제스트를 운영 메시지로 렌더링하고,
  필요할 때 허브 알람으로 전송한다.
  """

  alias TeamJay.Blog.FeedbackDigest
  alias Jay.Core.HubClient

  def build_message(style \\ :ops) do
    FeedbackDigest.build()
    |> format(style)
    |> prepend_header()
  end

  def notify(opts \\ []) do
    style = Keyword.get(opts, :style, :ops)
    send? = Keyword.get(opts, :send, false)

    message = build_message(style)

    if send? do
      response = HubClient.post_alarm(message, "blog", "blog-phase3")
      %{sent: true, message: message, response: summarize_response(response)}
    else
      %{sent: false, message: message}
    end
  end

  defp format(digest, :brief) do
    health = Map.get(digest, :health, %{})
    feedback = Map.get(digest, :feedback, %{})
    alerts = Map.get(digest, :alerts, %{})
    execution = Map.get(digest, :execution, %{})
    social = Map.get(digest, :social, %{})
    autonomy = Map.get(digest, :autonomy, %{})
    autonomy_health = Map.get(autonomy, :health, %{})
    autonomy_latest = Map.get(autonomy, :latest_decision, %{})

    parts = [
      "phase3=#{render_health(Map.get(health, :status, :warming_up))}",
      "feedback=#{Map.get(feedback, :feedback_count, 0)}"
    ]

    parts =
      if Map.get(health, :failed_signal_count, 0) > 0 do
        parts ++ ["failSignals=#{Map.get(health, :failed_signal_count, 0)}"]
      else
        parts
      end

    parts =
      case Map.get(feedback, :recent_keys, []) do
        [first | _] -> parts ++ ["last=#{first}"]
        _ -> parts
      end

    parts =
      if Map.get(alerts, :total_count, 0) > 0 do
        parts ++ ["alerts=#{Map.get(alerts, :total_count, 0)}"]
      else
        parts
      end

    parts =
      case render_recent_failure_hint(execution, social) do
        "none" -> parts
        value -> parts ++ ["fail=#{value}"]
      end

    parts =
      parts ++ [
        "autonomy=#{render_health(Map.get(autonomy_health, :status, :warming_up))}",
        "auto=#{Map.get(autonomy_health, :auto_publish_count, 0)}"
      ]

    parts =
      case render_recent_autonomy(autonomy_latest) do
        "none" -> parts
        value -> parts ++ ["autonomyLast=#{value}"]
      end

    Enum.join(parts, " ")
  end

  defp format(digest, :ops) do
    health = Map.get(digest, :health, %{})
    feedback = Map.get(digest, :feedback, %{})
    execution = Map.get(digest, :execution, %{})
    social = Map.get(digest, :social, %{})
    alerts = Map.get(digest, :alerts, %{})
    autonomy = Map.get(digest, :autonomy, %{})
    autonomy_health = Map.get(autonomy, :health, %{})
    autonomy_latest = Map.get(autonomy, :latest_decision, %{})
    recent_failure = render_recent_failure_hint(execution, social)

    [
      "블로그 Phase 3 피드백 리포트",
      "상태: #{render_health(Map.get(health, :status, :warming_up))}",
      "Feedback: #{Map.get(feedback, :feedback_count, 0)}건",
      "Node failures: #{Map.get(execution, :failed_count, 0)}",
      "Social failures: #{Map.get(social, :failed_count, 0)}",
      "Alert 합계: #{Map.get(alerts, :total_count, 0)}",
      "Autonomy: #{render_health(Map.get(autonomy_health, :status, :warming_up))}, auto #{Map.get(autonomy_health, :auto_publish_count, 0)}, review #{Map.get(autonomy_health, :master_review_count, 0)}, recent #{render_recent_autonomy(autonomy_latest)}",
      "최근 feedback: #{render_recent_feedback(feedback)}",
      "최근 실패 힌트: #{if recent_failure == "none", do: "none", else: recent_failure}",
      "추천: #{render_recommendation(digest)}"
    ]
    |> Enum.join("\n")
  end

  defp render_recent_feedback(feedback) do
    case Map.get(feedback, :recent_keys, []) do
      [] -> "none"
      items -> Enum.take(items, 2) |> Enum.join(", ")
    end
  end

  defp render_recent_autonomy(nil), do: "none"
  defp render_recent_autonomy(latest) when latest == %{}, do: "none"
  defp render_recent_autonomy(latest) do
    decision = Map.get(latest, :decision, "unknown")
    post_type = Map.get(latest, :post_type, "post")
    "#{post_type}:#{decision}"
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

  defp render_recent_failure_hint(execution, social) do
    cond do
      match = render_recent_node_failure(execution) -> match
      match = render_recent_social_failure(social) -> match
      true -> "none"
    end
  end

  defp render_recent_node_failure(execution) do
    execution
    |> Map.get(:recent_failures, [])
    |> List.first()
    |> case do
      nil -> false
      item -> "#{Map.get(item, :post_type, "node")}:#{Map.get(item, :run_status, "failed")}"
    end
  end

  defp render_recent_social_failure(social) do
    social
    |> Map.get(:recent_failures, [])
    |> List.first()
    |> case do
      nil -> false
      item -> "#{Map.get(item, :channel, "social")}:#{Map.get(item, :run_status, "failed")}"
    end
  end

  defp prepend_header(message) do
    "🧩 블로그 Phase 3 피드백 리포트\n" <> message
  end

  defp render_health(:ok), do: "정상"
  defp render_health(:warn), do: "주의"
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
