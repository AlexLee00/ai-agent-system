defmodule TeamJay.Blog.MarketingSnapshot do
  @moduledoc """
  블로그 마케팅 운영 스냅샷 기록기.

  Node 쪽 marketing digest를 읽어 event_lake에 적재한다.
  """

  alias TeamJay.EventLake
  alias TeamJay.Config

  @blog_root "/Users/alexlee/projects/ai-agent-system/bots/blog"
  @script Path.join(@blog_root, "scripts/marketing-digest.ts")

  def build do
    {output, 0} =
      System.cmd("node", [@script, "--json"],
        cd: @blog_root,
        env: [
          {"PG_DIRECT", "1"},
          {"TEAM_JAY_REPO_ROOT", Config.repo_root()}
        ],
        stderr_to_stdout: true
      )

    output
    |> extract_json()
    |> Jason.decode!()
    |> normalize()
  end

  def persist do
    snapshot = build()
    brief = build_brief(snapshot)

    EventLake.record(%{
      event_type: "blog_marketing_snapshot",
      team: "blog",
      bot_name: "blog.marketing",
      severity: severity(snapshot),
      title: "블로그 마케팅 운영 스냅샷",
      message: brief,
      tags: ["blog", "marketing", "snapshot", "ops"],
      metadata: snapshot
    })

    %{brief: brief, snapshot: snapshot}
  end

  def build_brief(snapshot) do
    status = get_in(snapshot, ["health", "status"]) || "unknown"
    signal_count = get_in(snapshot, ["senseSummary", "signalCount"]) || 0
    impact_pct =
      snapshot
      |> get_in(["revenueCorrelation", "revenueImpactPct"])
      |> to_float()
      |> Kernel.*(100)
      |> :erlang.float_to_binary(decimals: 1)

    autonomy_count = get_in(snapshot, ["autonomySummary", "totalCount"]) || 0
    weakness = get_in(snapshot, ["diagnosis", "primaryWeakness", "code"]) || "stable"

    "marketing=#{status} signals=#{signal_count} impact=#{impact_pct}% autonomy=#{autonomy_count} weakness=#{weakness}"
  end

  defp severity(snapshot) do
    case get_in(snapshot, ["health", "status"]) do
      "watch" -> "warn"
      "error" -> "error"
      _ -> "info"
    end
  end

  defp extract_json(output) do
    text = String.trim(output || "")

    if String.starts_with?(text, "{") do
      text
    else
      json_lines =
        text
        |> String.split("\n")
        |> Enum.drop_while(&(String.trim_leading(&1) |> String.starts_with?("{") |> Kernel.not()))

      case json_lines do
        [] ->
          raise "marketing digest JSON을 찾지 못했습니다"

        lines ->
          lines
          |> Enum.join("\n")
          |> String.trim()
      end
    end
  end

  defp normalize(map) when is_map(map) do
    Map.put_new(map, "generatedAt", DateTime.utc_now() |> DateTime.to_iso8601())
  end

  defp to_float(nil), do: 0.0
  defp to_float(value) when is_float(value), do: value
  defp to_float(value) when is_integer(value), do: value / 1
  defp to_float(value) when is_binary(value) do
    case Float.parse(value) do
      {parsed, _} -> parsed
      :error -> 0.0
    end
  end
  defp to_float(_), do: 0.0
end
