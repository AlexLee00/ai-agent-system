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
    if is_binary(weakness) and weakness != "", do: ", latest weakness #{weakness}", else: ""
  end

  defp render_marketing_brief(nil), do: ""
  defp render_marketing_brief(latest) when latest == %{}, do: ""
  defp render_marketing_brief(latest) do
    case Map.get(latest, :latest_weakness) do
      value when is_binary(value) and value != "" -> ",weak=#{value}"
      _ -> ""
    end
  end

  defp render_marketing_strategy(nil), do: ""
  defp render_marketing_strategy(strategy) when strategy == %{}, do: ""
  defp render_marketing_strategy(strategy) do
    category = Map.get(strategy, :preferred_category)
    pattern = Map.get(strategy, :preferred_title_pattern)

    cond do
      is_binary(category) and category != "" and is_binary(pattern) and pattern != "" ->
        ", strategy #{category}/#{pattern}"
      is_binary(category) and category != "" ->
        ", strategy #{category}"
      is_binary(pattern) and pattern != "" ->
        ", strategy #{pattern}"
      true ->
        ""
    end
  end

  defp render_marketing_strategy_brief(nil), do: ""
  defp render_marketing_strategy_brief(strategy) when strategy == %{}, do: ""
  defp render_marketing_strategy_brief(strategy) do
    category = Map.get(strategy, :preferred_category)
    pattern = Map.get(strategy, :preferred_title_pattern)

    cond do
      is_binary(category) and category != "" and is_binary(pattern) and pattern != "" ->
        ",plan=#{category}:#{pattern}"
      is_binary(category) and category != "" ->
        ",plan=#{category}"
      is_binary(pattern) and pattern != "" ->
        ",plan=#{pattern}"
      true ->
        ""
    end
  end

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
