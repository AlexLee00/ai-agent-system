defmodule TeamJay.Blog.MarketingNotifier do
  @moduledoc """
  블로그팀 마케팅 확장 알림 도우미.

  marketing digest를 운영 메시지로 렌더링하고,
  필요할 때 허브 알람으로 전송한다.
  """

  alias TeamJay.Blog.MarketingDigest
  alias Jay.Core.HubClient

  def build_message(style \\ :ops) do
    MarketingDigest.build()
    |> format(style)
    |> prepend_header()
  end

  def notify(opts \\ []) do
    style = Keyword.get(opts, :style, :ops)
    send? = Keyword.get(opts, :send, false)

    message = build_message(style)

    if send? do
      response = HubClient.post_alarm(message, "blog", "blog-marketing")
      %{sent: true, message: message, response: summarize_response(response)}
    else
      %{sent: false, message: message}
    end
  end

  defp format(digest, :brief) do
    health = Map.get(digest, :health, %{})
    latest = Map.get(digest, :latest_snapshot, %{})
    strategy = Map.get(digest, :strategy, %{})
    preview = Map.get(latest, :next_general_preview, %{})

    parts = [
      "marketing=#{render_health(Map.get(health, :status, :warming_up))}",
      "snap=#{Map.get(health, :total_count, 0)}",
      "watch=#{Map.get(health, :watch_count, 0)}",
      "signal=#{Map.get(health, :avg_signal_count, 0)}",
      "impact=#{render_pct(Map.get(health, :avg_revenue_impact_pct, 0))}"
    ]

    parts =
      case render_recent_weakness(latest) do
        "none" -> parts
        value -> parts ++ ["weak=#{value}"]
      end

    parts =
      case render_channel_watch_hint(latest) do
        "none" -> parts
        value -> parts ++ ["channel=#{compact_channel_watch_hint(value)}"]
      end

    parts =
      case Map.get(latest, :channel_watch_count, 0) do
        value when is_integer(value) and value >= 0 -> parts ++ ["ch=#{value}"]
        _ -> parts
      end

    parts =
      case render_strategy_hint(strategy) do
        "none" -> parts
        value -> parts ++ ["plan=#{value}"]
      end

    parts =
      case render_next_preview_brief(preview) do
        "none" -> parts
        value -> parts ++ ["next=#{value}"]
      end

    Enum.join(parts, " ")
  end

  defp format(digest, :ops) do
    health = Map.get(digest, :health, %{})
    latest = Map.get(digest, :latest_snapshot, %{})
    strategy = Map.get(digest, :strategy, %{})
    preview = Map.get(latest, :next_general_preview, %{})

    [
      "블로그 마케팅 확장 리포트",
      "상태: #{render_health(Map.get(health, :status, :warming_up))}",
      "Snapshots: #{Map.get(health, :total_count, 0)}건",
      "OK/Watch: #{Map.get(health, :ok_count, 0)} / #{Map.get(health, :watch_count, 0)}",
      "Avg signal count: #{Map.get(health, :avg_signal_count, 0)}",
      "Avg revenue impact: #{render_pct(Map.get(health, :avg_revenue_impact_pct, 0))}",
      "최근 weakness: #{render_recent_weakness(latest)}",
      "채널 watch: #{render_channel_watch_hint(latest)}",
      "현재 전략: #{render_strategy_hint(strategy)}",
      "다음 preview: #{render_next_preview(preview)}",
      "추천: #{render_recommendation(digest)}"
    ]
    |> Enum.join("\n")
  end

  defp render_recent_weakness(nil), do: "none"
  defp render_recent_weakness(latest) when latest == %{}, do: "none"

  defp render_recent_weakness(latest) do
    case Map.get(latest, :latest_weakness) do
      value when is_binary(value) and value != "" -> value
      _ -> "none"
    end
  end

  defp render_channel_watch_hint(nil), do: "none"
  defp render_channel_watch_hint(latest) when latest == %{}, do: "none"

  defp render_channel_watch_hint(latest) do
    case Map.get(latest, :channel_watch_hint) do
      value when is_binary(value) and value != "" -> value
      _ -> "none"
    end
  end

  defp compact_channel_watch_hint(value) when is_binary(value) do
    cond do
      String.starts_with?(value, "instagram watch:") and String.contains?(value, "실패") ->
        case Regex.run(~r/실패\s+(\d+)건/u, value) do
          [_, failed] -> "instagram:fail#{failed}"
          _ -> "instagram:watch"
        end

      String.starts_with?(value, "naver_blog warming-up:") ->
        "naver_blog:warming_up"

      true ->
        value
        |> String.replace(" ", "_")
        |> String.replace(",", "_")
    end
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

  defp render_strategy_hint(nil), do: "none"
  defp render_strategy_hint(strategy) when strategy == %{}, do: "none"
  defp render_strategy_hint(strategy) do
    category = Map.get(strategy, :preferred_category)
    pattern = Map.get(strategy, :preferred_title_pattern)

    cond do
      is_binary(category) and category != "" and is_binary(pattern) and pattern != "" ->
        "#{category}/#{pattern}"
      is_binary(category) and category != "" ->
        category
      is_binary(pattern) and pattern != "" ->
        pattern
      true ->
        "none"
    end
  end

  defp render_next_preview(nil), do: "none"
  defp render_next_preview(preview) when preview == %{}, do: "none"
  defp render_next_preview(preview) do
    category = Map.get(preview, :category)
    pattern = Map.get(preview, :pattern)
    title = Map.get(preview, :compact_title) || Map.get(preview, :title)
    predicted = Map.get(preview, :predicted_adoption) || Map.get(preview, :predictedAdoption)

    cond do
      is_binary(category) and category != "" and is_binary(pattern) and pattern != "" and is_binary(title) and title != "" and is_binary(predicted) and predicted != "" ->
        "#{category}/#{pattern}/#{predicted} — #{title}"
      is_binary(category) and category != "" and is_binary(pattern) and pattern != "" ->
        "#{category}/#{pattern}"
      true ->
        "none"
    end
  end

  defp render_next_preview_brief(nil), do: "none"
  defp render_next_preview_brief(preview) when preview == %{}, do: "none"
  defp render_next_preview_brief(preview) do
    category = Map.get(preview, :category)
    pattern = Map.get(preview, :pattern)
    predicted = Map.get(preview, :predicted_adoption) || Map.get(preview, :predictedAdoption)

    cond do
      is_binary(category) and category != "" and is_binary(pattern) and pattern != "" and is_binary(predicted) and predicted != "" ->
        "#{category}/#{pattern}:#{predicted}"
      is_binary(category) and category != "" and is_binary(pattern) and pattern != "" ->
        "#{category}/#{pattern}"
      true ->
        "none"
    end
  end

  defp prepend_header(message) do
    "📣 블로그 마케팅 확장 리포트\n" <> message
  end

  defp render_health(:ok), do: "정상"
  defp render_health(:warn), do: "주의"
  defp render_health(:watch), do: "주의"
  defp render_health(other), do: to_string(other)

  defp render_pct(value) when is_float(value), do: :erlang.float_to_binary(value * 100, decimals: 1) <> "%"
  defp render_pct(value) when is_integer(value), do: render_pct(value * 1.0)
  defp render_pct(_value), do: "0.0%"

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
