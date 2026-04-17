defmodule Jay.V2.Skill.WeeklyReviewer do
  @moduledoc """
  WeeklyReviewer — 주간 리포트 생성 (매주 월요일 07:30 KST).
  Jay.V2.WeeklyReport.run/0을 래핑해 Commander에서 호출 가능한 Skill로 노출.
  """

  use Jido.Action,
    name: "jay_v2_weekly_reviewer",
    description: "Generate weekly report and send to master via Telegram",
    schema: Zoi.object(%{
      week_ending: Zoi.default(Zoi.string(), "")
    })

  @impl Jido.Action
  def run(params, _ctx) do
    week_ending =
      case Map.get(params, :week_ending, "") do
        "" -> Date.to_iso8601(Date.utc_today())
        d -> d
      end

    case Jay.V2.WeeklyReport.run() do
      :ok ->
        {:ok, %{week_ending: week_ending, result: :ok}}

      :error ->
        {:error, "weekly_report failed"}

      other ->
        {:ok, %{week_ending: week_ending, result: other}}
    end
  rescue
    e -> {:error, "weekly_reviewer error: #{inspect(e)}"}
  end
end
