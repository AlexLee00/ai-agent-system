defmodule Mix.Tasks.TeamJay.Dashboard.Phase52Check do
  @moduledoc """
  Visibility v3.3 Cycle #52 verification.

  The default mode is read-only. Optional flags:

    * `--ingest-recent` - upsert recent `codex.task.*` / `project.*` EventLake rows.
    * `--reconcile-milestones` - run MilestoneSentry reconciliation once.
    * `--json` - print JSON.
  """
  use Mix.Task

  @shortdoc "Verifies Visibility v3.3 Cycle #52 readiness"

  @impl true
  def run(args) do
    json? = "--json" in args
    ingest_recent? = "--ingest-recent" in args
    reconcile? = "--reconcile-milestones" in args

    ensure_repo_started!()

    ingest_result =
      if ingest_recent? do
        TeamJay.Dashboard.ProjectRepo.ingest_recent_event_lake_tasks!(limit: 200)
      end

    reconcile_result =
      if reconcile? do
        TeamJay.Dashboard.ProjectRepo.reconcile_milestones!()
      end

    source_checks = source_checks()
    runtime = runtime_health()
    trace_kpi = trace_kpi()
    snapshot = TeamJay.Dashboard.ProjectRepo.snapshot()

    checks =
      Map.merge(source_checks, %{
        runtime_phase_g: runtime.phase == "G",
        project_schema_ready: snapshot.schema_ready?,
        project_data_visible: length(snapshot.projects) >= 4 and length(snapshot.tasks) >= 30,
        area_11_gantt_ready: length(snapshot.gantt.dates) == 15,
        milestone_data_visible: length(snapshot.milestones) >= 8
      })

    result = %{
      ok: Enum.all?(Map.values(checks)),
      phase: "Cycle #52",
      visibility_version: "v3.3",
      checks: checks,
      runtime_health: runtime,
      trace_kpi: trace_kpi,
      project_snapshot: %{
        projects: length(snapshot.projects),
        tasks: length(snapshot.tasks),
        milestones: length(snapshot.milestones),
        active_sessions: length(snapshot.active_sessions),
        conflicts: get_in(snapshot, [:metrics, :conflicts]) || 0
      },
      ingest_result: ingest_result,
      reconcile_result: reconcile_result,
      manual_visual_validation: [
        "브라우저에서 11개 영역이 모두 보이는지 확인",
        "영역 4 trace_id 클릭 후 영역 9 상세 표시 확인",
        "영역 10 task stage 변경 후 Project + Timeline 즉시 반영 확인"
      ]
    }

    if json? do
      Mix.shell().info(Jason.encode!(result, pretty: true))
    else
      Enum.each(checks, fn {name, ok?} ->
        Mix.shell().info("#{if ok?, do: "ok", else: "fail"} #{name}")
      end)

      Mix.shell().info("trace_ratio=#{trace_kpi.trace_ratio}")
      Mix.shell().info("runtime_phase=#{runtime.phase || "unavailable"}")
    end

    unless result.ok, do: System.halt(1)
  end

  defp source_checks do
    dashboard = read!("lib/team_jay/dashboard/live/dashboard_live.ex")
    project_repo = read!("lib/team_jay/dashboard/project_repo.ex")
    session_tracker = read!("lib/team_jay/dashboard/session_tracker.ex")
    milestone_sentry = read!("lib/team_jay/dashboard/milestone_sentry.ex")
    event_ingestor = read!("lib/team_jay/dashboard/project_event_ingestor.ex")
    app = read!("lib/team_jay/application.ex")
    darwin_pwc = read!("../../bots/darwin/elixir/lib/darwin/v2/sensor/papers_with_code.ex")

    %{
      eleven_areas_wired:
        String.contains?(dashboard, "[9] Langfuse Trace 상세") and
          String.contains?(dashboard, "[10] Project + Milestone 보드") and
          String.contains?(dashboard, "[11] TimelineGantt 2주"),
      project_repo_split:
        String.contains?(project_repo, "defmodule TeamJay.Dashboard.ProjectRepo") and
          String.contains?(project_repo, "ingest_event"),
      session_tracker_split:
        String.contains?(session_tracker, "defmodule TeamJay.Dashboard.SessionTracker") and
          String.contains?(session_tracker, "conflict_files"),
      milestone_sentry_split:
        String.contains?(milestone_sentry, "defmodule TeamJay.Dashboard.MilestoneSentry") and
          String.contains?(app, "TeamJay.Dashboard.MilestoneSentry"),
      event_ingestor_split:
        String.contains?(event_ingestor, "defmodule TeamJay.Dashboard.ProjectEventIngestor") and
          String.contains?(app, "TeamJay.Dashboard.ProjectEventIngestor"),
      papers_with_code_html_guard:
        String.contains?(darwin_pwc, "unexpected_body") and
          String.contains?(darwin_pwc, "is_map(body)")
    }
  end

  defp runtime_health do
    port =
      System.get_env("TEAM_JAY_DASHBOARD_PORT")
      |> Kernel.||(System.get_env("DASHBOARD_PORT"))
      |> Kernel.||("7787")

    case Req.get("http://localhost:#{port}/healthz", receive_timeout: 2_000) do
      {:ok, %{status: 200, body: %{"phase" => phase, "layer" => layer} = body}} ->
        %{ok: true, phase: phase, layer: layer, body: body}

      {:ok, %{status: status}} ->
        %{ok: false, phase: nil, status: status}

      {:error, reason} ->
        %{ok: false, phase: nil, error: inspect(reason)}
    end
  rescue
    error -> %{ok: false, phase: nil, error: inspect(error)}
  end

  defp trace_kpi do
    sql = """
    SELECT
      COUNT(*)::int,
      COUNT(*) FILTER (
        WHERE trace_id IS NOT NULL
          AND trace_id <> ''
          AND trace_id <> '00000000000000000000000000000000'
      )::int
    FROM agent.event_lake
    WHERE created_at >= NOW() - INTERVAL '24 hours'
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: [[total, traced]]}} ->
        ratio = if total > 0, do: Float.round(traced / total, 4), else: 0.0

        %{
          total_events_24h: total,
          traced_events_24h: traced,
          trace_ratio: ratio,
          target_ratio: 0.5,
          target_met: ratio >= 0.5
        }

      _ ->
        %{
          total_events_24h: 0,
          traced_events_24h: 0,
          trace_ratio: 0.0,
          target_ratio: 0.5,
          target_met: false
        }
    end
  rescue
    error ->
      %{
        total_events_24h: 0,
        traced_events_24h: 0,
        trace_ratio: 0.0,
        target_ratio: 0.5,
        target_met: false,
        error: inspect(error)
      }
  end

  defp read!(relative_or_absolute_path) do
    path =
      if Path.type(relative_or_absolute_path) == :absolute do
        relative_or_absolute_path
      else
        File.cwd!() |> Path.join(relative_or_absolute_path) |> Path.expand()
      end

    File.read!(path)
  end

  defp ensure_repo_started! do
    {:ok, _} = Application.ensure_all_started(:postgrex)
    {:ok, _} = Application.ensure_all_started(:ecto_sql)

    case Process.whereis(Jay.Core.Repo) do
      nil ->
        {:ok, _pid} = Jay.Core.Repo.start_link()
        :ok

      _pid ->
        :ok
    end
  end
end
