defmodule Jay.V2.Skill.DailyBriefingComposer do
  @moduledoc """
  DailyBriefingComposer — 9팀 상태 수집 후 일일 브리핑 텍스트 생성.
  Jay.V2.TeamConnector.collect_all/0 → Jay.V2.DailyBriefing.generate/2 파이프라인.
  """

  use Jido.Action,
    name: "jay_v2_daily_briefing_composer",
    description: "Collect all team states and compose daily briefing text",
    schema: Zoi.object(%{
      date: Zoi.default(Zoi.string(), "")
    })

  @impl Jido.Action
  def run(params, _ctx) do
    date =
      case Map.get(params, :date, "") do
        "" -> Date.to_iso8601(Date.utc_today())
        d -> d
      end

    teams_data = Jay.V2.TeamConnector.collect_all()
    briefing_text = Jay.V2.DailyBriefing.generate(teams_data, date)

    {:ok, %{date: date, briefing_text: briefing_text, teams_data: teams_data}}
  rescue
    e -> {:error, "briefing_composer error: #{inspect(e)}"}
  end
end
