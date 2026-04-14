defmodule TeamJay.Blog.SummaryFormatter do
  @moduledoc """
  블로그팀 Phase 1 요약을 운영 메시지 형태로 바꾸는 포매터.

  텔레그램/헬스 리포트 같은 외부 채널로 넘기기 쉬운
  짧은 텍스트 표현을 제공한다.
  """

  def format(summary, style \\ :ops)

  def format(summary, :ops) do
    node = summary.node_publish
    social = summary.social
    alerts = summary.alerts
    phase3 = Map.get(summary, :phase3_feedback, %{})
    phase4 = Map.get(summary, :phase4_competition, %{})
    autonomy = Map.get(summary, :autonomy, %{})
    marketing = Map.get(summary, :marketing, %{})
    phase3_health = Map.get(phase3, :health, %{})
    phase3_feedback = Map.get(phase3, :feedback, %{})
    phase3_execution = Map.get(phase3, :execution, %{})
    phase3_social = Map.get(phase3, :social, %{})
    phase4_health = Map.get(phase4, :health, %{})
    phase4_quality = Map.get(phase4, :quality, %{})
    autonomy_health = Map.get(autonomy, :health, %{})
    autonomy_latest = Map.get(autonomy, :latest_decision, %{})
    marketing_health = Map.get(marketing, :health, %{})
    marketing_latest = Map.get(marketing, :latest_snapshot, %{})
    marketing_strategy = Map.get(marketing, :strategy, %{})
    recent_feedback = render_recent_feedback(phase3_feedback)
    fail_signals = Map.get(phase3_health, :failed_signal_count, 0)
    fail_hint = render_phase3_fail_hint(phase3_execution, phase3_social)

    [
      "블로그 Phase 1 요약",
      "상태: #{render_health(summary.health.status)}",
      "Node: run #{node.run_count}, ok #{node.ok_count}, dry-run ok #{node.dry_run_ok_count}, fail #{node.failed_count}, alert #{node.alert_count}",
      "Social: relay #{social.relayed_count}, ok #{social.ok_count}, fail #{social.failed_count}, alert #{social.alert_count}",
      "채널: instagram #{render_channel(Map.get(social.by_channel, "instagram", %{}))} / naver #{render_channel(Map.get(social.by_channel, "naver_blog", %{}))}",
      "Alert 합계: #{alerts.total_count}",
      "Phase 3: #{render_health(Map.get(phase3_health, :status, :warming_up))}, feedback #{Map.get(phase3_feedback, :feedback_count, 0)}, failed signals #{fail_signals}#{recent_feedback}#{fail_hint}",
      "Phase 4: #{render_health(Map.get(phase4_health, :status, :warming_up))}, competitions #{Map.get(phase4_health, :total_count, 0)}, timeout #{Map.get(phase4_health, :timeout_count, 0)}, avg diff #{Map.get(phase4_quality, :avg_quality_diff, "n/a")}",
      "Autonomy: #{render_health(Map.get(autonomy_health, :status, :warming_up))}, decisions #{Map.get(autonomy_health, :total_count, 0)}, auto #{Map.get(autonomy_health, :auto_publish_count, 0)}, review #{Map.get(autonomy_health, :master_review_count, 0)}#{render_autonomy_latest(autonomy_latest)}",
      "Marketing: #{render_health(Map.get(marketing_health, :status, :warming_up))}, snapshots #{Map.get(marketing_health, :total_count, 0)}, watch #{Map.get(marketing_health, :watch_count, 0)}, avg impact #{render_pct(Map.get(marketing_health, :avg_revenue_impact_pct))}#{render_marketing_latest(marketing_latest)}#{render_marketing_strategy(marketing_strategy)}"
    ]
    |> Enum.join("\n")
  end

  def format(summary, :brief) do
    node = summary.node_publish
    social = summary.social
    phase3 = Map.get(summary, :phase3_feedback, %{})
    phase4 = Map.get(summary, :phase4_competition, %{})
    autonomy = Map.get(summary, :autonomy, %{})
    marketing = Map.get(summary, :marketing, %{})
    phase3_health = Map.get(phase3, :health, %{})
    phase3_feedback = Map.get(phase3, :feedback, %{})
    phase3_execution = Map.get(phase3, :execution, %{})
    phase3_social = Map.get(phase3, :social, %{})
    phase4_health = Map.get(phase4, :health, %{})
    autonomy_health = Map.get(autonomy, :health, %{})
    autonomy_latest = Map.get(autonomy, :latest_decision, %{})
    marketing_health = Map.get(marketing, :health, %{})
    marketing_latest = Map.get(marketing, :latest_snapshot, %{})
    marketing_strategy = Map.get(marketing, :strategy, %{})
    phase3_parts = [
      render_health(Map.get(phase3_health, :status, :warming_up)),
      "feedback=#{Map.get(phase3_feedback, :feedback_count, 0)}"
    ]
    |> maybe_append_phase3("failSignals=#{Map.get(phase3_health, :failed_signal_count, 0)}", Map.get(phase3_health, :failed_signal_count, 0) > 0)
    |> maybe_append_phase3("last=#{render_recent_feedback_key(phase3_feedback)}", render_recent_feedback_key(phase3_feedback) != "none")
    |> maybe_append_phase3("fail=#{render_phase3_fail_brief(phase3_execution, phase3_social)}", render_phase3_fail_brief(phase3_execution, phase3_social) != "none")

    [
      "phase1=#{render_health(summary.health.status)}",
      "node(ok=#{node.ok_count},fail=#{node.failed_count},dry=#{node.dry_run_ok_count})",
      "social(ok=#{social.ok_count},fail=#{social.failed_count},alert=#{social.alert_count})",
      "phase3(#{Enum.join(phase3_parts, ",")})",
      "phase4(#{render_health(Map.get(phase4_health, :status, :warming_up))},comp=#{Map.get(phase4_health, :total_count, 0)},timeout=#{Map.get(phase4_health, :timeout_count, 0)})",
      "autonomy(#{render_health(Map.get(autonomy_health, :status, :warming_up))},n=#{Map.get(autonomy_health, :total_count, 0)},auto=#{Map.get(autonomy_health, :auto_publish_count, 0)}#{render_autonomy_brief(autonomy_latest)})",
      "marketing(#{render_health(Map.get(marketing_health, :status, :warming_up))},snap=#{Map.get(marketing_health, :total_count, 0)},watch=#{Map.get(marketing_health, :watch_count, 0)}#{render_marketing_brief(marketing_latest)}#{render_marketing_strategy_brief(marketing_strategy)})"
    ]
    |> Enum.join(" ")
  end

  defp maybe_append_phase3(parts, value, true), do: parts ++ [value]
  defp maybe_append_phase3(parts, _value, false), do: parts

  defp render_recent_feedback(feedback) do
    key = render_recent_feedback_key(feedback)
    if key == "none", do: "", else: ", recent #{key}"
  end

  defp render_phase3_fail_hint(execution, social) do
    value = render_phase3_fail_brief(execution, social)
    if value == "none", do: "", else: ", fail #{value}"
  end

  defp render_phase3_fail_brief(execution, social) do
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
      nil ->
        false

      item ->
        post_type = Map.get(item, :post_type, "node")
        status = Map.get(item, :run_status, "failed")
        "#{post_type}:#{status}"
    end
  end

  defp render_recent_social_failure(social) do
    social
    |> Map.get(:recent_failures, [])
    |> List.first()
    |> case do
      nil ->
        false

      item ->
        channel = Map.get(item, :channel, "social")
        status = Map.get(item, :run_status, "failed")
        "#{channel}:#{status}"
    end
  end

  defp render_recent_feedback_key(feedback) do
    feedback
    |> Map.get(:recent_keys, [])
    |> List.first()
    |> case do
      nil -> "none"
      value -> to_string(value)
    end
  end

  defp render_autonomy_latest(nil), do: ""
  defp render_autonomy_latest(latest) when latest == %{}, do: ""
  defp render_autonomy_latest(latest) do
    decision = Map.get(latest, :decision, "unknown")
    title = latest |> Map.get(:title, "") |> to_string() |> String.slice(0, 36)
    if title == "", do: "", else: ", latest #{decision} #{title}"
  end

  defp render_autonomy_brief(nil), do: ""
  defp render_autonomy_brief(latest) when latest == %{}, do: ""
  defp render_autonomy_brief(latest) do
    ",last=#{Map.get(latest, :decision, "unknown")}"
  end

  defp render_marketing_latest(nil), do: ""
  defp render_marketing_latest(latest) when latest == %{}, do: ""
  defp render_marketing_latest(latest) do
    weakness = Map.get(latest, :latest_weakness)
    channel_hint = Map.get(latest, :channel_watch_hint)

    cond do
      is_binary(weakness) and weakness != "" and is_binary(channel_hint) and channel_hint != "" ->
        ", latest weakness #{weakness}, channel #{channel_hint}"
      is_binary(weakness) and weakness != "" ->
        ", latest weakness #{weakness}"
      is_binary(channel_hint) and channel_hint != "" ->
        ", channel #{channel_hint}"
      true ->
        ""
    end
  end

  defp render_marketing_brief(nil), do: ""
  defp render_marketing_brief(latest) when latest == %{}, do: ""
  defp render_marketing_brief(latest) do
    weakness =
      case Map.get(latest, :latest_weakness) do
        value when is_binary(value) and value != "" -> ",weak=#{value}"
        _ -> ""
      end

    channel =
      case Map.get(latest, :channel_watch_hint) do
        value when is_binary(value) and value != "" -> ",channel=#{compact_channel_watch_hint(value)}"
        _ -> ""
      end

    current_watch =
      case Map.get(latest, :channel_watch_count, 0) do
        value when is_integer(value) and value >= 0 -> ",ch=#{value}"
        _ -> ""
      end

    weakness <> current_watch <> channel
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

  defp render_marketing_strategy(nil), do: ""
  defp render_marketing_strategy(strategy) when strategy == %{}, do: ""
  defp render_marketing_strategy(strategy) do
    category = Map.get(strategy, :preferred_category)
    pattern = Map.get(strategy, :preferred_title_pattern)
    hotspot = render_marketing_hotspot(strategy)

    cond do
      is_binary(category) and category != "" and is_binary(pattern) and pattern != "" ->
        ", strategy #{category}/#{pattern}#{hotspot}"
      is_binary(category) and category != "" ->
        ", strategy #{category}#{hotspot}"
      is_binary(pattern) and pattern != "" ->
        ", strategy #{pattern}#{hotspot}"
      hotspot != "" ->
        hotspot
      true ->
        ""
    end
  end

  defp render_marketing_strategy_brief(nil), do: ""
  defp render_marketing_strategy_brief(strategy) when strategy == %{}, do: ""
  defp render_marketing_strategy_brief(strategy) do
    category = Map.get(strategy, :preferred_category)
    pattern = Map.get(strategy, :preferred_title_pattern)
    hotspot = render_marketing_hotspot_brief(strategy)

    cond do
      is_binary(category) and category != "" and is_binary(pattern) and pattern != "" ->
        ",plan=#{category}:#{pattern}#{hotspot}"
      is_binary(category) and category != "" ->
        ",plan=#{category}#{hotspot}"
      is_binary(pattern) and pattern != "" ->
        ",plan=#{pattern}#{hotspot}"
      hotspot != "" ->
        hotspot
      true ->
        ""
    end
  end

  defp render_marketing_hotspot(nil), do: ""
  defp render_marketing_hotspot(strategy) when strategy == %{}, do: ""
  defp render_marketing_hotspot(strategy) do
    hotspot = Map.get(strategy, :category_pattern_hotspot) || %{}
    category = hotspot_value(hotspot, :category)
    pattern = hotspot_value(hotspot, :topPattern)

    cond do
      is_binary(category) and category != "" and is_binary(pattern) and pattern != "" ->
        ", hotspot #{category}/#{pattern}"
      is_binary(category) and category != "" ->
        ", hotspot #{category}"
      true ->
        ""
    end
  end

  defp render_marketing_hotspot_brief(nil), do: ""
  defp render_marketing_hotspot_brief(strategy) when strategy == %{}, do: ""
  defp render_marketing_hotspot_brief(strategy) do
    hotspot = Map.get(strategy, :category_pattern_hotspot) || %{}
    category = hotspot_value(hotspot, :category)

    cond do
      is_binary(category) and category != "" -> ",hot=#{category}"
      true -> ""
    end
  end

  defp hotspot_value(map, key) when is_map(map) do
    Map.get(map, key) || Map.get(map, Atom.to_string(key))
  end

  defp hotspot_value(_map, _key), do: nil

  defp render_pct(nil), do: "0.0%"
  defp render_pct(value) when is_float(value), do: :erlang.float_to_binary(value * 100, decimals: 1) <> "%"
  defp render_pct(value) when is_integer(value), do: render_pct(value * 1.0)
  defp render_pct(_value), do: "0.0%"

  defp render_channel(channel) do
    "t#{Map.get(channel, :total_count, 0)}/o#{Map.get(channel, :ok_count, 0)}/f#{Map.get(channel, :failed_count, 0)}"
  end

  defp render_health(:ok), do: "정상"
  defp render_health(:warn), do: "주의"
  defp render_health(:watch), do: "주의"
  defp render_health(:cooldown), do: "정리중"
  defp render_health(other), do: to_string(other)
end
