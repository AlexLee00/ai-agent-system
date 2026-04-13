defmodule Mix.Tasks.Blog.Phase1.Summary do
  use Mix.Task

  @shortdoc "블로그팀 Phase 1 일간 요약을 출력합니다"
  @requirements ["app.start"]

  @moduledoc """
  블로그팀 Elixir 리모델링 Phase 1의 실행/소셜/알람 상태를
  운영자가 빠르게 확인할 수 있는 일간 요약을 출력한다.

  ## Examples

      mix blog.phase1.summary
      mix blog.phase1.summary --json
  """

  alias TeamJay.Blog.DailySummary

  @impl Mix.Task
  def run(args) do
    summary = DailySummary.build()

    if "--json" in args do
      Mix.shell().info(Jason.encode_to_iodata!(summary, pretty: true))
    else
      Mix.shell().info(render_text(summary))
    end
  end

  defp render_text(summary) do
    node = summary.node_publish
    social = summary.social
    alerts = summary.alerts

    [
      "Blog Phase 1 Daily Summary",
      "generated_at: #{summary.generated_at}",
      "health: #{summary.health.status}",
      "",
      "Node Publish",
      "run_count=#{node.run_count} ok_count=#{node.ok_count} dry_run_ok_count=#{node.dry_run_ok_count} failed_count=#{node.failed_count} inflight_count=#{node.inflight_count} alert_count=#{node.alert_count}",
      "",
      "Social",
      "relayed_count=#{social.relayed_count} total_count=#{social.total_count} ok_count=#{social.ok_count} failed_count=#{social.failed_count} alert_count=#{social.alert_count}",
      "instagram=#{render_channel(Map.get(social.by_channel, "instagram", %{}))}",
      "naver_blog=#{render_channel(Map.get(social.by_channel, "naver_blog", %{}))}",
      "",
      "Alerts",
      "total=#{alerts.total_count} node_publish=#{alerts.node_publish.alert_count} social=#{alerts.social.alert_count}"
    ]
    |> Enum.join("\n")
  end

  defp render_channel(channel) do
    "total=#{Map.get(channel, :total_count, 0)} ok=#{Map.get(channel, :ok_count, 0)} failed=#{Map.get(channel, :failed_count, 0)}"
  end
end
