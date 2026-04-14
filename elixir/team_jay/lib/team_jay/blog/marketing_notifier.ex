defmodule TeamJay.Blog.MarketingNotifier do
  @moduledoc """
  블로그팀 마케팅 확장 알림 도우미.

  marketing digest를 운영 메시지로 렌더링하고,
  필요할 때 허브 알람으로 전송한다.
  """

  alias TeamJay.Blog.MarketingDigest
  alias TeamJay.HubClient

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
      case render_strategy_hint(strategy) do
        "none" -> parts
        value -> parts ++ ["plan=#{value}"]
      end

    Enum.join(parts, " ")
  end

  defp format(digest, :ops) do
    health = Map.get(digest, :health, %{})
    latest = Map.get(digest, :latest_snapshot, %{})
    strategy = Map.get(digest, :strategy, %{})

    [
      "블로그 마케팅 확장 리포트",
      "상태: #{render_health(Map.get(health, :status, :warming_up))}",
      "Snapshots: #{Map.get(health, :total_count, 0)}건",
      "OK/Watch: #{Map.get(health, :ok_count, 0)} / #{Map.get(health, :watch_count, 0)}",
      "Avg signal count: #{Map.get(health, :avg_signal_count, 0)}",
      "Avg revenue impact: #{render_pct(Map.get(health, :avg_revenue_impact_pct, 0))}",
      "최근 weakness: #{render_recent_weakness(latest)}",
      "현재 전략: #{render_strategy_hint(strategy)}",
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
