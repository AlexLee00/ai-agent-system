defmodule Mix.Tasks.Blog.Phase1.Report do
  use Mix.Task

  @shortdoc "블로그팀 Phase 1 운영 메시지를 출력합니다"
  @requirements ["app.start"]

  @moduledoc """
  블로그팀 Elixir 리모델링 Phase 1 상태를
  운영 메시지 형태로 렌더링해서 출력한다.

  ## Examples

      mix blog.phase1.report
      mix blog.phase1.report --brief
      mix blog.phase1.report --json
  """

  alias TeamJay.Blog.DailySummary
  alias TeamJay.Blog.SummaryFormatter

  @impl Mix.Task
  def run(args) do
    summary = DailySummary.build()

    cond do
      "--json" in args ->
        Mix.shell().info(Jason.encode_to_iodata!(summary, pretty: true))

      "--brief" in args ->
        Mix.shell().info(SummaryFormatter.format(summary, :brief))

      true ->
        Mix.shell().info(SummaryFormatter.format(summary, :ops))
    end
  end
end
