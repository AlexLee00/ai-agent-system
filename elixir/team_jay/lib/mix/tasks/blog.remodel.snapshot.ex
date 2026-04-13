defmodule Mix.Tasks.Blog.Remodel.Snapshot do
  use Mix.Task

  @shortdoc "블로그 리모델링 운영 스냅샷을 event_lake에 기록"

  @moduledoc """
  현재 블로그 리모델링 요약을 event_lake에 적재한다.

      mix blog.remodel.snapshot
      mix blog.remodel.snapshot --json
      mix blog.remodel.snapshot --dry-run
  """

  alias TeamJay.Blog.DailySummary
  alias TeamJay.Blog.RemodelSnapshot

  @impl true
  def run(args) do
    Mix.Task.run("app.start")

    {opts, _rest, _invalid} =
      OptionParser.parse(args,
        strict: [json: :boolean, dry_run: :boolean],
        aliases: [j: :json]
      )

    summary = DailySummary.build()

    snapshot =
      if opts[:dry_run] do
        RemodelSnapshot.build(summary)
      else
        RemodelSnapshot.persist(summary)
      end

    payload = %{
      persisted: !opts[:dry_run],
      snapshot: snapshot
    }

    if opts[:json] do
      Mix.shell().info(Jason.encode!(payload))
    else
      Mix.shell().info("블로그 리모델링 스냅샷")
      Mix.shell().info("persisted: #{payload.persisted}")
      Mix.shell().info("phase1: #{snapshot.phase1_brief}")
      Mix.shell().info("phase3: #{get_in(snapshot, [:phase3_feedback, :health, :status])}")
      Mix.shell().info("phase4: #{get_in(snapshot, [:phase4_competition, :health, :status])}")
      Mix.shell().info("autonomy: #{get_in(snapshot, [:autonomy, :health, :status])}")
    end
  end
end
