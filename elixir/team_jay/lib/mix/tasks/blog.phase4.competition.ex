defmodule Mix.Tasks.Blog.Phase4.Competition do
  use Mix.Task

  @shortdoc "블로그팀 Phase 4 경쟁 실험 요약을 출력합니다"
  @requirements ["app.start"]

  @moduledoc """
  agent.competitions 최근 데이터를 읽어
  블로그팀 경쟁 실험 상태를 요약해서 출력한다.

  ## Examples

      mix blog.phase4.competition
      mix blog.phase4.competition --json
      mix blog.phase4.competition --days 14
  """

  alias TeamJay.Blog.CompetitionDigest

  @impl Mix.Task
  def run(args) do
    {opts, _argv, _invalid} =
      OptionParser.parse(args, strict: [json: :boolean, days: :integer])

    digest = CompetitionDigest.build(Keyword.get(opts, :days, 7))

    if Keyword.get(opts, :json, false) do
      Mix.shell().info(Jason.encode!(digest))
    else
      Mix.shell().info(render_text(digest))
    end
  end

  defp render_text(digest) do
    health = Map.get(digest, :health, %{})
    winners = Map.get(digest, :winners, %{})
    quality = Map.get(digest, :quality, %{})
    recent =
      digest
      |> Map.get(:recent_topics, [])
      |> Enum.map(fn item ->
        "##{Map.get(item, :id)} #{Map.get(item, :topic)} (#{Map.get(item, :status)}, winner=#{Map.get(item, :winner) || "none"}, diff=#{Map.get(item, :quality_diff) || "n/a"})"
      end)
      |> Enum.join("\n")

    """
    Blog Phase 4 Competition
    lookback_days: #{Map.get(digest, :lookback_days, 7)}
    status: #{Map.get(health, :status, :warming_up)}
    total: #{Map.get(health, :total_count, 0)}
    completed: #{Map.get(health, :completed_count, 0)}
    running: #{Map.get(health, :running_count, 0)}
    pending: #{Map.get(health, :pending_count, 0)}
    timeout: #{Map.get(health, :timeout_count, 0)}
    winners: a=#{Map.get(winners, :a_count, 0)} b=#{Map.get(winners, :b_count, 0)} none=#{Map.get(winners, :none_count, 0)}
    avg_quality_diff: #{Map.get(quality, :avg_quality_diff, "n/a")}

    recent_topics:
    #{if recent == "", do: "none", else: recent}
    """
    |> String.trim()
  end
end
