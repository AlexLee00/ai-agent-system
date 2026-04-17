defmodule Sigma.V2.RollbackScheduler do
  @moduledoc """
  Tier 2 자동 롤백 스케줄러 — 24h 효과 측정 후 필요 시 자동 복원.
  Phase 3: Config.restore + Memory 업데이트 + Reflexion 트리거.
  참조: bots/sigma/docs/PLAN.md §6 Phase 3
  """

  use GenServer
  require Logger

  def start_link(_opts), do: GenServer.start_link(__MODULE__, %{}, name: __MODULE__)

  def init(state), do: {:ok, state}

  @doc "24h 후 효과 측정 + 필요 시 롤백 예약."
  def schedule(opts) when is_list(opts) do
    GenServer.cast(__MODULE__, {:schedule, Map.new(opts)})
  end
  def schedule(opts) when is_map(opts) do
    GenServer.cast(__MODULE__, {:schedule, opts})
  end

  def handle_cast({:schedule, opts}, state) do
    delay_ms = opts[:measure_at_ms] || :timer.hours(24)
    Process.send_after(self(), {:measure_and_rollback, opts}, delay_ms)
    {:noreply, state}
  end

  def handle_info({:measure_and_rollback, opts}, state) do
    team = opts[:team] || "unknown"
    before_metric = opts[:before_metric] || %{}
    after_metric = collect_team_metric(team)

    effectiveness = compute_effectiveness(before_metric, after_metric)

    Logger.info("[sigma/rollback] team=#{team} effectiveness=#{Float.round(effectiveness, 3)}")

    cond do
      effectiveness < -0.10 ->
        Logger.warning("[sigma/rollback] 악화 감지 (#{Float.round(effectiveness * 100, 1)}%) — 자동 롤백: #{team}")
        _ = Sigma.V2.Config.restore(team, opts[:snapshot_id])

        Sigma.V2.Memory.store(:procedural,
          "rollback: #{opts[:directive_id]}",
          importance: 0.75
        )

        Sigma.V2.Archivist.log_rollback(opts, effectiveness)

        # Reflexion 자동 생성 (stub directive)
        stub_dir = %{
          analyst: "rollback_scheduler",
          team: team,
          action: %{type: "auto_rollback"},
          rollback_spec: %{directive_id: opts[:directive_id]}
        }
        spawn(fn -> Sigma.V2.Reflexion.reflect(stub_dir, %{
          effectiveness: effectiveness,
          metric_delta: %{before: before_metric, after: after_metric}
        }) end)

      effectiveness >= 0.30 ->
        Sigma.V2.Memory.store(:semantic,
          "success: #{opts[:directive_id]}",
          importance: min(effectiveness, 1.0)
        )

      true ->
        Sigma.V2.Memory.store(:episodic,
          "neutral: #{opts[:directive_id]}",
          importance: 0.3,
          expires_in: :timer.hours(24 * 30)
        )
    end

    {:noreply, state}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # ---

  defp collect_team_metric(team) do
    sql = """
    SELECT COALESCE(ROUND(AVG(score)::numeric, 2), 5.0)::float AS avg_score
    FROM agent.registry WHERE team = $1
    """
    case Jay.Core.Repo.query(sql, [team]) do
      {:ok, %{rows: [[v]]}} when is_float(v) -> %{avg_score: v}
      _ -> %{avg_score: 5.0}
    end
  rescue
    _ -> %{avg_score: 5.0}
  end

  defp compute_effectiveness(%{avg_score: before_score}, %{avg_score: after_score})
    when is_number(before_score) and before_score > 0 do
    (after_score - before_score) / before_score
  end
  defp compute_effectiveness(_, _), do: 0.0
end
