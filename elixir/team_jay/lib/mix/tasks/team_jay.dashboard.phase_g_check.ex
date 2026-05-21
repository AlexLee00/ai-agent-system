defmodule Mix.Tasks.TeamJay.Dashboard.PhaseGCheck do
  @moduledoc """
  Visibility v3.4 Phase G dashboard smoke.

  Default mode is static and non-mutating. Use `--apply-schema` to create the
  append-only project schema, and `--seed` to insert deterministic marker data.
  """
  use Mix.Task

  @shortdoc "Checks TeamJay Visibility v3.4 Phase G wiring"

  @impl true
  def run(args) do
    json? = "--json" in args
    apply_schema? = "--apply-schema" in args
    seed? = "--seed" in args

    if apply_schema? or seed? do
      ensure_repo_started!()
      TeamJay.Dashboard.ProjectVisibility.ensure_schema!()
    end

    seed_result =
      if seed? do
        TeamJay.Dashboard.ProjectVisibility.seed_marker_data!()
      else
        nil
      end

    repo_root = repo_root()
    dashboard_source = read!("lib/team_jay/dashboard/live/dashboard_live.ex")
    health_source = read!("lib/team_jay/dashboard/health_plug.ex")
    project_source = read!("lib/team_jay/dashboard/project_visibility.ex")
    project_repo_source = read!("lib/team_jay/dashboard/project_repo.ex")
    session_tracker_source = read!("lib/team_jay/dashboard/session_tracker.ex")
    milestone_sentry_source = read!("lib/team_jay/dashboard/milestone_sentry.ex")
    event_ingestor_source = read!("lib/team_jay/dashboard/project_event_ingestor.ex")
    application_source = read!("lib/team_jay/application.ex")

    migration_source =
      read!("priv/repo/migrations/20260516000001_create_project_visibility_schema.exs")

    config_source = read!(Path.join(repo_root, "config/projects.yaml"))
    visibility_doc = read_visibility_doc!(repo_root)
    marker_counts = TeamJay.Dashboard.ProjectVisibility.marker_counts()
    schema_ready? = schema_ready_readonly?()

    checks = %{
      visibility_doc_authority:
        String.contains?(visibility_doc, "v3.4 = v3.3") or
          String.contains?(visibility_doc, "v3.3 본질 100% 도달 조건"),
      phase_g_header: String.contains?(dashboard_source, "Phase G • 영역 1~11"),
      area_10_rendered:
        String.contains?(dashboard_source, "project_milestone_board") and
          String.contains?(dashboard_source, "[10] Project + Milestone 보드"),
      area_10_action_queue:
        String.contains?(dashboard_source, "진행 후보 · 마일스톤/장기대기 우선순위") and
          String.contains?(project_source, "def build_action_items") and
          String.contains?(project_source, "missed_milestone") and
          String.contains?(project_source, "stale_task"),
      area_11_rendered:
        String.contains?(dashboard_source, "timeline_gantt_board") and
          String.contains?(dashboard_source, "[11] TimelineGantt 2주"),
      area_9_initial_slot:
        String.contains?(dashboard_source, "<.trace_detail_board") and
          String.contains?(dashboard_source, "trace_id={@selected_trace_id}") and
          String.contains?(dashboard_source, "attr(:trace_id, :string, default: nil)") and
          String.contains?(dashboard_source, "영역 4의 trace_id 클릭") and
          String.contains?(dashboard_source, "Trace 선택 안 됨") and
          not String.contains?(dashboard_source, "<%= if @selected_trace_id do %>"),
      project_topics:
        Enum.all?(
          [
            "project.task.created",
            "project.task.stage_changed",
            "project.milestone.added",
            "project.milestone.achieved",
            "project.milestone.missed"
          ],
          &String.contains?(dashboard_source, &1)
        ),
      project_schema_migration:
        Enum.all?(
          [
            "project.projects",
            "project.tasks",
            "project.milestones",
            "project.sessions",
            "project.metrics"
          ],
          &String.contains?(migration_source, &1)
        ),
      project_repo_adapter:
        String.contains?(project_source, "def snapshot") and
          String.contains?(project_source, "def ensure_schema!") and
          String.contains?(project_source, "seed_marker_data!"),
      project_repo_boundary:
        String.contains?(project_repo_source, "defmodule TeamJay.Dashboard.ProjectRepo") and
          String.contains?(project_repo_source, "ingest_recent_event_lake_tasks!"),
      session_tracker_boundary:
        String.contains?(session_tracker_source, "defmodule TeamJay.Dashboard.SessionTracker") and
          String.contains?(session_tracker_source, "conflict_files"),
      milestone_sentry_boundary:
        String.contains?(milestone_sentry_source, "defmodule TeamJay.Dashboard.MilestoneSentry") and
          String.contains?(milestone_sentry_source, "reconcile_now"),
      project_event_ingest_boundary:
        String.contains?(
          event_ingestor_source,
          "defmodule TeamJay.Dashboard.ProjectEventIngestor"
        ) and
          String.contains?(event_ingestor_source, "event_lake:new") and
          String.contains?(application_source, "TeamJay.Dashboard.ProjectEventIngestor"),
      milestone_sentry_supervised:
        String.contains?(application_source, "TeamJay.Dashboard.MilestoneSentry"),
      whitelist_config:
        String.contains?(config_source, "included:") and
          String.contains?(config_source, "ai-agent-system") and
          String.contains?(config_source, "luna-autonomy"),
      marker_project_count: marker_counts.projects >= 4,
      marker_task_count: marker_counts.tasks >= 30,
      marker_milestone_count: marker_counts.milestones >= 8,
      health_phase_g:
        String.contains?(health_source, ~s(@dashboard_phase "G")) and
          String.contains?(health_source, "Visibility v3.4")
    }

    result = %{
      ok: Enum.all?(Map.values(checks)),
      phase: "G",
      dashboard_url: "http://localhost:#{dashboard_port()}",
      schema_ready: schema_ready?,
      schema_applied_this_run: apply_schema?,
      seed_result: seed_result,
      marker_counts: marker_counts,
      checks: checks
    }

    if json? do
      Mix.shell().info(Jason.encode!(result, pretty: true))
    else
      Enum.each(checks, fn {name, ok?} ->
        Mix.shell().info("#{if ok?, do: "ok", else: "fail"} #{name}")
      end)

      Mix.shell().info("schema_ready=#{schema_ready?}")
      Mix.shell().info("dashboard_url=#{result.dashboard_url}")
    end

    unless result.ok, do: System.halt(1)
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

  defp read_visibility_doc!(repo_root) do
    ["VISIBILITY_SYSTEM_v3.4.md", "VISIBILITY_SYSTEM_v3.3.md"]
    |> Enum.map(&Path.join([repo_root, "docs/strategy", &1]))
    |> Enum.find(&File.exists?/1)
    |> case do
      nil ->
        raise File.Error, reason: :enoent, action: "read file", path: "VISIBILITY_SYSTEM_v3.4.md"

      path ->
        File.read!(path)
    end
  end

  defp repo_root do
    File.cwd!()
    |> Path.join("../..")
    |> Path.expand()
  end

  defp dashboard_port do
    System.get_env("TEAM_JAY_DASHBOARD_PORT")
    |> Kernel.||(System.get_env("DASHBOARD_PORT"))
    |> Kernel.||("7787")
    |> String.to_integer()
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

  defp schema_ready_readonly? do
    ensure_repo_started!()
    TeamJay.Dashboard.ProjectVisibility.schema_ready?()
  rescue
    _ -> false
  end
end
