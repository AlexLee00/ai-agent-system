defmodule Jay.V2.Skill.TeamHealthCheck do
  @moduledoc """
  TeamHealthCheck — 팀 상태 수집 및 건강도 평가.
  Jay.V2.TeamConnector를 통해 팀별 KPI를 수집하고 healthy/degraded/failed 판정.
  """

  use Jido.Action,
    name: "jay_v2_team_health_check",
    description: "Collect team KPIs and evaluate health status (healthy/degraded/failed)",
    schema: Zoi.object(%{
      team: Zoi.default(Zoi.string(), "all")
    })

  @impl Jido.Action
  def run(params, _ctx) do
    team = Map.get(params, :team, "all")

    result =
      if team == "all" do
        all_health = Jay.V2.TeamConnector.collect_all()
        Enum.map(all_health, fn {t, data} -> build_health(t, data) end)
      else
        data = Jay.V2.TeamConnector.collect(String.to_existing_atom(team))
        [build_health(team, data)]
      end

    {:ok, %{team: team, results: result}}
  rescue
    _ -> {:ok, %{team: "unknown", results: [], status: :unknown}}
  end

  defp build_health(team, nil), do: %{team: team, status: :unknown, metrics: %{}}

  defp build_health(team, data) when is_map(data) do
    status =
      cond do
        Map.get(data, :error) != nil -> :failed
        Map.get(data, :unhealthy, false) -> :degraded
        true -> :healthy
      end

    %{team: team, status: status, metrics: data}
  end
end
