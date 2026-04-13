defmodule Mix.Tasks.Blog.Phase3.Feedback do
  use Mix.Task

  @shortdoc "블로그팀 Phase 3 피드백 다이제스트를 출력합니다"
  @requirements ["app.start"]

  @moduledoc """
  블로그팀 Elixir 리모델링 Phase 3용 피드백 신호를 한 번에 묶어
  운영 회고/후속 학습 입력으로 볼 수 있는 다이제스트를 출력한다.

  ## Examples

      mix blog.phase3.feedback
      mix blog.phase3.feedback --json
  """

  alias TeamJay.Blog.FeedbackDigest

  @impl Mix.Task
  def run(args) do
    digest = FeedbackDigest.build()

    if "--json" in args do
      Mix.shell().info(Jason.encode!(digest))
    else
      Mix.shell().info(render_text(digest))
    end
  end

  defp render_text(digest) do
    [
      "Blog Phase 3 Feedback Digest",
      "generated_at: #{digest.generated_at}",
      "health: #{digest.health.status}",
      "feedback_count: #{digest.feedback.feedback_count}",
      "node_failures: #{digest.execution.failed_count}",
      "social_failures: #{digest.social.failed_count}",
      "alert_total: #{digest.alerts.total_count}",
      "",
      "Recent feedback keys",
      render_list(digest.feedback.recent_keys),
      "",
      "Recommendations",
      render_list(digest.recommendations)
    ]
    |> Enum.join("\n")
  end

  defp render_list([]), do: "- none"
  defp render_list(items), do: Enum.map_join(items, "\n", &"- #{&1}")
end
