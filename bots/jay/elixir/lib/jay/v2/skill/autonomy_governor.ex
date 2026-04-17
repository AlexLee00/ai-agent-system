defmodule Jay.V2.Skill.AutonomyGovernor do
  @moduledoc """
  AutonomyGovernor — 팀별 자율 레벨 관리 + 승격/강등 판정.
  Jay.V2.AutonomyController GenServer를 래핑해 Commander에서 사용한다.

  actions: status | record_intervention | record_clean_day
  """

  use Jido.Action,
    name: "jay_v2_autonomy_governor",
    description: "Manage team autonomy level (query status, record events)",
    schema: Zoi.object(%{
      action: Zoi.default(Zoi.string(), "status"),
      team: Zoi.default(Zoi.string(), "jay")
    })

  @impl Jido.Action
  def run(params, _ctx) do
    action = Map.get(params, :action, "status")
    team = Map.get(params, :team, "jay")

    result = execute_action(action, team)
    {:ok, result}
  rescue
    e -> {:error, "autonomy_governor error: #{inspect(e)}"}
  end

  defp execute_action("status", _team) do
    status = Jay.V2.AutonomyController.get_status()
    phase = Jay.V2.AutonomyController.get_phase()
    decision = if phase >= 3, do: :allow, else: :escalate
    %{phase: phase, status: status, decision: decision}
  end

  defp execute_action("record_intervention", _team) do
    Jay.V2.AutonomyController.record_master_intervention()
    %{action: "record_intervention", result: :ok}
  end

  defp execute_action("record_clean_day", _team) do
    Jay.V2.AutonomyController.record_clean_day()
    %{action: "record_clean_day", result: :ok}
  end

  defp execute_action(unknown, _team) do
    %{error: "unknown action: #{unknown}"}
  end
end
