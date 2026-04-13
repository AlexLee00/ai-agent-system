defmodule Mix.Tasks.Blog.Marketing.Snapshot do
  use Mix.Task

  @shortdoc "블로그 마케팅 운영 스냅샷을 event_lake에 기록"

  @moduledoc """
  Node marketing digest를 읽어 event_lake에 적재한다.

      mix blog.marketing.snapshot
      mix blog.marketing.snapshot --json
      mix blog.marketing.snapshot --dry-run
  """

  alias TeamJay.Blog.MarketingSnapshot

  @impl true
  def run(args) do
    Mix.Task.run("app.start")

    {opts, _rest, _invalid} =
      OptionParser.parse(args,
        strict: [json: :boolean, dry_run: :boolean],
        aliases: [j: :json]
      )

    payload =
      if opts[:dry_run] do
        snapshot = MarketingSnapshot.build()
        %{persisted: false, brief: MarketingSnapshot.build_brief(snapshot), snapshot: snapshot}
      else
        result = MarketingSnapshot.persist()
        %{persisted: true, brief: result.brief, snapshot: result.snapshot}
      end

    if opts[:json] do
      Mix.shell().info(Jason.encode!(payload))
    else
      Mix.shell().info("블로그 마케팅 스냅샷")
      Mix.shell().info("persisted: #{payload.persisted}")
      Mix.shell().info(payload.brief)
    end
  end
end
