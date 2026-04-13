defmodule Mix.Tasks.Blog.Phase1.Status do
  use Mix.Task

  @shortdoc "블로그팀 Phase 1 상태를 요약해서 출력합니다"
  @requirements ["app.start"]

  @moduledoc """
  블로그팀 Elixir 리모델링 Phase 1 상태를 조용히 조회하는 Mix task.

  ## Examples

      mix blog.phase1.status
      mix blog.phase1.status --json
  """

  alias TeamJay.Blog.StatusSnapshot

  @impl Mix.Task
  def run(args) do
    status = StatusSnapshot.collect()

    if "--json" in args do
      Mix.shell().info(Jason.encode_to_iodata!(status, pretty: true))
    else
      Mix.shell().info(render_text(status))
    end
  end

  defp render_text(status) do
    [
      "Blog Phase 1 Status",
      "date: #{Date.utc_today()}",
      "",
      render_line("orchestrator", status.orchestrator),
      render_line("researcher", status.researcher),
      render_line("writer_pos", status.writer_pos),
      render_line("writer_gems", status.writer_gems),
      render_line("editor", status.editor),
      render_line("publisher", status.publisher),
      render_line("port_bridge", status.port_bridge),
      render_line("node_publish_agent", status.node_publish_agent),
      render_line("node_publish_executor", status.node_publish_executor),
      render_line("node_publish_runner", status.node_publish_runner),
      render_line("execution_monitor", status.execution_monitor),
      render_line("feedback", status.feedback),
      render_line("social_relay", status.social_relay),
      render_line("instagram_agent", status.instagram_agent),
      render_line("instagram_executor", status.instagram_executor),
      render_line("instagram_runner", status.instagram_runner),
      render_line("naver_blog_agent", status.naver_blog_agent),
      render_line("naver_blog_executor", status.naver_blog_executor),
      render_line("naver_blog_runner", status.naver_blog_runner),
      render_line("social_execution_monitor", status.social_execution_monitor),
      render_line("social_alert_relay", status.social_alert_relay),
      render_line("alert_relay", status.alert_relay)
    ]
    |> Enum.join("\n")
  end

  defp render_line(name, %{error: error} = status) do
    reason =
      status
      |> Map.get(:reason, "")
      |> to_string()

    "* #{name}: error=#{error} #{reason}"
    |> String.trim()
  end

  defp render_line(name, status) when is_map(status) do
    summary =
      status
      |> Enum.filter(fn {key, _value} ->
        key in [
          :queue_size,
          :completed_size,
          :drafted_count,
          :approved_count,
          :published_count,
          :handoff_count,
          :executed_count,
          :run_count,
          :ok_count,
          :dry_run_ok_count,
          :total_count,
          :verify_ok_count,
          :failed_count,
          :prepared_count,
          :queued_count,
          :feedback_count,
          :relayed_count,
          :alert_count,
          :last_run_at,
          :last_seen_at,
          :last_prepared_at,
          :last_alert_at
        ]
      end)
      |> Enum.map(fn {key, value} -> "#{key}=#{inspect(value)}" end)
      |> Enum.join(" ")

    if summary == "" do
      "* #{name}: ok"
    else
      "* #{name}: #{summary}"
    end
  end
end
